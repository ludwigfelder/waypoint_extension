import { appendFile, mkdir, readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  INTERACTION_LOG_SCHEMA_VERSION,
  assertInteractionEvent,
  type InteractionEvent,
  type InteractionEventInput,
} from "../shared/interactionLog";

type Append = (path: string, data: string) => Promise<unknown>;
type AppendSync = (path: string, data: string) => void;

export class InteractionLogger {
  readonly path: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(
    waypointDir: string,
    private readonly now: () => number = Date.now,
    private readonly append: Append = appendFile,
    private readonly id: () => string = randomUUID,
    private readonly appendSync: AppendSync = appendFileSync,
  ) {
    this.path = join(waypointDir, "logs", "interactions.jsonl");
  }

  async init(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
  }

  private build(plan: string, version: number, input: InteractionEventInput): InteractionEvent {
    const event = {
      schemaVersion: INTERACTION_LOG_SCHEMA_VERSION,
      eventId: this.id(),
      timestamp: new Date(this.now()).toISOString(),
      plan,
      version,
      ...input,
    } as InteractionEvent;
    assertInteractionEvent(event);
    return event;
  }

  log(plan: string, version: number, input: InteractionEventInput): Promise<InteractionEvent> {
    const event = this.build(plan, version, input);

    const write = async () => {
      try {
        await this.append(this.path, JSON.stringify(event) + "\n");
      } catch (error) {
        console.error("[waypoint] interaction log write failed:", error);
      }
    };
    this.queue = this.queue.then(write, write);
    return this.queue.then(() => event);
  }

  /** Synchronous append for shutdown paths (deactivate cannot await). */
  logSync(plan: string, version: number, input: InteractionEventInput): InteractionEvent {
    const event = this.build(plan, version, input);
    try {
      this.appendSync(this.path, JSON.stringify(event) + "\n");
    } catch (error) {
      console.error("[waypoint] interaction log sync write failed:", error);
    }
    return event;
  }

  async readAll(): Promise<InteractionEvent[]> {
    try {
      const text = await readFile(this.path, "utf8");
      return text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const event: unknown = JSON.parse(line);
          assertInteractionEvent(event);
          return event;
        });
    } catch (error: any) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
  }
}
