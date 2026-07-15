type EventPayload = Record<string, unknown>;

class SseHub {
  private clients = new Set<NodeJS.WritableStream>();

  add(stream: NodeJS.WritableStream): () => void {
    this.clients.add(stream);
    stream.write(": connected\n\n");
    return () => {
      this.clients.delete(stream);
    };
  }

  broadcast(event: string, payload: EventPayload): void {
    const message = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const client of this.clients) {
      try {
        client.write(message);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}

export const sseHub = new SseHub();
