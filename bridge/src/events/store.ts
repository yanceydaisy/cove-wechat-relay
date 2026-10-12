import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type Subscription = {
  id: string;
  owner: string;
  name: "cove.bridge.requested";
  arguments: { source: "wechat.dm" };
  url: string;
  secret: string;
  previousSecret?: string;
  rotationExpiresAt?: string;
  refreshBefore: string;
  active: boolean;
};

export class EventsStore {
  private subscriptions = new Map<string, Subscription>();

  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    try {
      const values = JSON.parse(await readFile(this.file, "utf8")) as Subscription[];
      const now = new Date().toISOString();
      for (const value of values) {
        if (value.name === "cove.bridge.requested" && value.refreshBefore > now) {
          this.subscriptions.set(value.id, value);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  get(id: string): Subscription | undefined { return this.subscriptions.get(id); }
  all(): Subscription[] { return [...this.subscriptions.values()]; }

  async put(value: Subscription): Promise<void> {
    this.subscriptions.set(value.id, value);
    await this.save();
  }

  async remove(id: string): Promise<void> {
    this.subscriptions.delete(id);
    await this.save();
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    await writeFile(temporary, JSON.stringify(this.all(), null, 2), { mode: 0o600 });
    await rename(temporary, this.file);
  }
}
