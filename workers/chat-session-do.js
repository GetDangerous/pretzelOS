/**
 * Dangerous Pretzel Co — Chat Session Durable Object
 *
 * Replaces KV-based chat sessions (24h TTL) with durable, persistent storage.
 * Each chat session is its own DO instance — hibernates when idle (zero cost),
 * wakes on new message, never expires.
 *
 * Drew can close the dashboard and return days later to the same thread.
 *
 * Storage API:
 *   GET  /history       → { history: [...] }
 *   PUT  /history       → { history: [...] } → { saved: true }
 *   DELETE /history     → { cleared: true }
 *   GET  /meta          → { created_at, last_active, message_count }
 */

export class ChatSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname === '/history' || url.pathname.endsWith('/history')) {

        if (request.method === 'GET') {
          const history = (await this.state.storage.get('history')) || [];
          return Response.json({ history });
        }

        if (request.method === 'PUT') {
          const body = await request.json();
          const history = body.history || [];
          // Trim to last 40 turns (20 exchanges) before saving to limit storage
          const trimmed = history.slice(-40);
          await this.state.storage.put('history', trimmed);
          // Update metadata
          const meta = (await this.state.storage.get('meta')) || { created_at: new Date().toISOString() };
          meta.last_active = new Date().toISOString();
          meta.message_count = (meta.message_count || 0) + 1;
          await this.state.storage.put('meta', meta);
          return Response.json({ saved: true, stored_turns: trimmed.length });
        }

        if (request.method === 'DELETE') {
          await this.state.storage.deleteAll();
          return Response.json({ cleared: true });
        }

      }

      if (url.pathname === '/meta' || url.pathname.endsWith('/meta')) {
        if (request.method === 'GET') {
          const meta = (await this.state.storage.get('meta')) || {};
          const history = (await this.state.storage.get('history')) || [];
          return Response.json({
            ...meta,
            turn_count: history.length,
          });
        }
      }

      return new Response('Not found', { status: 404 });

    } catch (err) {
      console.error('[ChatSessionDO] Error:', err.message);
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
