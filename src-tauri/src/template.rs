use regex::Regex;
use serde_json::Value;
use std::sync::LazyLock;

static VARIABLE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").unwrap());

pub fn render(input: &str, environment: &Value) -> Result<String, String> {
    let mut result = input.to_string();
    for _ in 0..16 {
        if !VARIABLE.is_match(&result) {
            if result.contains("{%") {
                return Err("Unsupported template tag. Replace it with an environment variable or a request script.".into());
            }
            return Ok(result);
        }
        let mut error = None;
        let next = VARIABLE
            .replace_all(&result, |captures: &regex::Captures| {
                let key = captures[1]
                    .trim()
                    .trim_start_matches("_.")
                    .trim_start_matches("environment.");
                if key == "$uuid" {
                    return uuid::Uuid::new_v4().to_string();
                }
                if key == "$timestamp" {
                    return (crate::models::now() / 1000).to_string();
                }
                let found = environment.get(key).or_else(|| {
                    key.split('.')
                        .try_fold(environment, |value, part| value.get(part))
                });
                match found {
                    Some(Value::String(value)) => value.clone(),
                    Some(Value::Null) => String::new(),
                    Some(value) => value.to_string(),
                    None => {
                        error = Some(format!("Undefined environment variable: {key}"));
                        captures[0].to_string()
                    }
                }
            })
            .into_owned();
        if let Some(error) = error {
            return Err(error);
        }
        if next == result {
            return Err("Cyclic environment variable reference".into());
        }
        result = next;
    }
    Err("Environment variables exceed 16 levels of nesting".into())
}

pub fn render_value(value: &mut Value, environment: &Value) -> Result<(), String> {
    match value {
        Value::String(text) => *text = render(text, environment)?,
        Value::Array(values) => {
            for value in values {
                render_value(value, environment)?;
            }
        }
        Value::Object(values) => {
            for value in values.values_mut() {
                render_value(value, environment)?;
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn resolves_insomnia_and_postman_variables_recursively() {
        let env = json!({"host":"localhost:3000", "base":"http://{{ _.host }}", "user":{"id":42}});
        assert_eq!(
            render("{{ base }}/{{ _.user.id }}", &env).unwrap(),
            "http://localhost:3000/42"
        );
        assert!(render("{{ missing }}", &env)
            .unwrap_err()
            .contains("missing"));
        assert!(render("{{ a }}", &json!({"a":"{{ b }}", "b":"{{ a }}"})).is_err());
    }
}
