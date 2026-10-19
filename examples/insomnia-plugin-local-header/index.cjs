module.exports.requestHooks = [
  async (context) => {
    const count = ((await context.store.getItem('count')) || 0) + 1;
    await context.store.setItem('count', count);
    context.request.setHeader('X-Local-Request', String(count));
  },
];

module.exports.responseHooks = [
  (context) => {
    console.log(`Received HTTP ${context.response.getStatusCode()}`);
  },
];
