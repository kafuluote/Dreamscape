use crate::models::ResponseData;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;
use std::{path::Path, sync::Mutex};

pub struct Database(pub Mutex<Connection>);

impl Database {
    pub fn open(path: &Path) -> Result<Self, String> {
        let connection = Connection::open(path).map_err(|e| e.to_string())?;
        connection.execute_batch(
            "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
             CREATE TABLE IF NOT EXISTS documents (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS history (id TEXT PRIMARY KEY, request_id TEXT NOT NULL, timestamp INTEGER NOT NULL, value TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS history_request ON history(request_id, timestamp DESC);"
        ).map_err(|e| e.to_string())?;
        Ok(Self(Mutex::new(connection)))
    }

    pub fn load(&self, key: &str) -> Result<Option<Value>, String> {
        let connection = self.0.lock().map_err(|e| e.to_string())?;
        let value: Option<String> = connection
            .query_row("SELECT value FROM documents WHERE key=?1", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        value
            .map(|s| serde_json::from_str(&s).map_err(|e| e.to_string()))
            .transpose()
    }

    pub fn save(&self, key: &str, value: &Value) -> Result<(), String> {
        let text = serde_json::to_string(value).map_err(|e| e.to_string())?;
        if text.len() > 64 * 1024 * 1024 {
            return Err("Workspace exceeds the 64 MiB storage limit".into());
        }
        let connection = self.0.lock().map_err(|e| e.to_string())?;
        connection.execute("INSERT INTO documents(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value", params![key, text]).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn record(&self, response: &ResponseData) -> Result<(), String> {
        let mut connection = self.0.lock().map_err(|e| e.to_string())?;
        let transaction = connection.transaction().map_err(|e| e.to_string())?;
        transaction
            .execute(
                "INSERT INTO history(id,request_id,timestamp,value) VALUES(?1,?2,?3,?4)",
                params![
                    response.id,
                    response.request_id,
                    response.timestamp,
                    serde_json::to_string(response).map_err(|e| e.to_string())?
                ],
            )
            .map_err(|e| e.to_string())?;
        // Bound local history by count as well as bytes (large responses must not fill the disk).
        transaction.execute("DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY timestamp DESC LIMIT 200)", []).map_err(|e| e.to_string())?;
        transaction.execute("DELETE FROM history WHERE id IN (SELECT id FROM (SELECT id, SUM(length(value)) OVER (ORDER BY timestamp DESC, id) AS total FROM history) WHERE total > 104857600)", []).map_err(|e| e.to_string())?;
        transaction.commit().map_err(|e| e.to_string())
    }

    pub fn history(&self, request_id: &str) -> Result<Vec<Value>, String> {
        let connection = self.0.lock().map_err(|e| e.to_string())?;
        let mut query = connection
            .prepare(
                "SELECT value FROM history WHERE request_id=?1 ORDER BY timestamp DESC LIMIT 50",
            )
            .map_err(|e| e.to_string())?;
        let rows = query
            .query_map([request_id], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        rows.map(|r| {
            serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string())
        })
        .collect()
    }

    pub fn clear_history(&self) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|e| e.to_string())?
            .execute("DELETE FROM history", [])
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn workspace_survives_restart_without_an_account() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.sqlite");
        let workspace = json!({"version":1,"collections":[{"name":"Local"}],"requests":[]});
        Database::open(&path)
            .unwrap()
            .save("workspace", &workspace)
            .unwrap();
        assert_eq!(
            Database::open(&path).unwrap().load("workspace").unwrap(),
            Some(workspace)
        );
    }
}
