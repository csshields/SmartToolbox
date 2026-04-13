import { Hono } from 'hono';
import { serve } from 'hono/bun';

const app = new Hono();

app.get('/health', (c) => {
  return c.json({ status: 'Ok' });
});

app.post('/query', async (c) => {
    const message = await c.req.json();
    console.log(message);
    return c.json({ reply: 'Received' });
});

serve({ fetch: app.fetch, port: 3000 }, (info) => {
  console.log(`Server started at http://localhost:${info.port}`);
});
