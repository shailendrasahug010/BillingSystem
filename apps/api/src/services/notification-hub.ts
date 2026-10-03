import pg from "pg";
import { NOTIFY_CHANNEL, type NotifyPayload } from "./notifications.js";

export interface HubSubscriber {
  businessId: string;
  /** Whether this subscriber may see the notification (its person, or a permission they hold). */
  wants(payload: NotifyPayload): boolean;
  send(payload: NotifyPayload): void;
}

/**
 * Pushes new notifications to the apps that keep the live stream open
 * (GET /notifications/stream). Each API server holds one LISTEN connection on
 * the `notifications` channel, opened when the first app connects; a
 * notification created on any server is announced to all of them by NOTIFY
 * when its transaction commits. Only ids travel: the app then fetches what it
 * may see. A lost connection is opened again after a short wait.
 */
export class NotificationHub {
  private client: pg.Client | null = null;
  private starting: Promise<void> | null = null;
  private readonly subscribers = new Set<HubSubscriber>();
  private closed = false;

  constructor(
    private readonly connectionString: string,
    private readonly onError: (error: unknown) => void,
  ) {}

  /** Adds a subscriber; resolves once the server is listening. Returns the function that removes it. */
  async subscribe(subscriber: HubSubscriber): Promise<() => void> {
    this.subscribers.add(subscriber);
    try {
      await this.listen();
    } catch (e) {
      this.subscribers.delete(subscriber);
      throw e;
    }
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  get size(): number {
    return this.subscribers.size;
  }

  private async listen(): Promise<void> {
    if (this.client || this.closed) return;
    this.starting ??= (async () => {
      const client = new pg.Client({ connectionString: this.connectionString });
      client.on("notification", (msg) => this.dispatch(msg.payload));
      client.on("error", (e) => {
        this.onError(e);
        this.lost(client);
      });
      client.on("end", () => this.lost(client));
      await client.connect();
      await client.query(`listen ${NOTIFY_CHANNEL}`);
      this.client = client;
    })().finally(() => {
      this.starting = null;
    });
    await this.starting;
  }

  private lost(client: pg.Client): void {
    if (this.client !== client) return;
    this.client = null;
    void client.end().catch(() => undefined);
    if (!this.closed && this.subscribers.size) {
      setTimeout(() => void this.listen().catch(this.onError), 2_000).unref();
    }
  }

  private dispatch(raw: string | undefined): void {
    if (!raw) return;
    let payload: NotifyPayload;
    try {
      payload = JSON.parse(raw) as NotifyPayload;
    } catch {
      return;
    }
    for (const s of this.subscribers) {
      if (s.businessId === payload.b && s.wants(payload)) s.send(payload);
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.subscribers.clear();
    const client = this.client;
    this.client = null;
    await client?.end().catch(() => undefined);
  }
}
