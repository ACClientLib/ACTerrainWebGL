import type { RegionSkyObject, RegionSkyHook } from "./regionsky";

interface ScheduledHook {
  objectIndex: number;
  scriptId: number;
  hook: RegionSkyHook;
  createIndex: number;
  time: number;
  invocation: string;
}

export interface ActiveSkyEmitter {
  objectIndex: number;
  scriptId: number;
  createIndex: number;
  invocation: string;
  emitting: boolean;
}

/** PES time advances independently of astronomical time and time scrubbing. */
export class SkyEffectController {
  private readonly active = new Map<string, ActiveSkyEmitter>();
  private readonly timeline: ScheduledHook[] = [];
  private elapsed = 0;
  private cursor = 0;
  private groupIndex = -1;

  setGroup(groupIndex: number, objects: readonly RegionSkyObject[]): void {
    if (this.groupIndex === groupIndex) {
      return;
    }
    this.stop();
    this.groupIndex = groupIndex;
    for (const object of objects) {
      const effects = new Map(object.effects.map(effect => [effect.scriptId, effect]));
      const visiting = new Set<number>();
      const append = (scriptId: number, start: number, invocation: string): void => {
        const effect = effects.get(scriptId);
        if (!effect) {
          throw new Error(`Missing sky script ${scriptId}`);
        }
        if (visiting.has(scriptId)) {
          return;
        }
        visiting.add(scriptId);
        try {
          let createIndex = 0;
          for (let index = 0; index < effect.hooks.length; index++) {
            const hook = effect.hooks[index];
            const time = start + hook.startTime;
            if (hook.type === "call" && hook.calledScriptId !== null) {
              append(hook.calledScriptId, time, `${invocation}:call${index}`);
            } else {
              this.timeline.push({ objectIndex: object.objectIndex, scriptId, hook, createIndex, time, invocation: `${invocation}:${index}` });
            }
            if (hook.type === "create") {
              createIndex++;
            }
          }
        } finally {
          visiting.delete(scriptId);
        }
      };
      if (object.defaultPesObjectId !== null) {
        append(object.defaultPesObjectId, 0, `${object.objectIndex}:${object.defaultPesObjectId}`);
      }
    }
    this.timeline.sort((a, b) => a.time - b.time);
  }

  advance(deltaSeconds: number): void {
    this.elapsed += Math.max(0, Math.min(deltaSeconds, 0.25));
    while (this.cursor < this.timeline.length && this.timeline[this.cursor].time <= this.elapsed) {
      const event = this.timeline[this.cursor++];
      const key = `${event.objectIndex}:${event.hook.emitterId}`;
      if (event.hook.type === "create") {
        this.active.set(key, {
          objectIndex: event.objectIndex,
          scriptId: event.scriptId,
          createIndex: event.createIndex,
          invocation: event.invocation,
          emitting: true,
        });
      } else if (event.hook.type === "destroy") {
        this.active.delete(key);
      } else if (event.hook.type === "stop") {
        const emitter = this.active.get(key);
        if (emitter) {
          emitter.emitting = false;
        }
      }
    }
  }

  stop(): void {
    this.active.clear();
    this.timeline.length = 0;
    this.elapsed = 0;
    this.cursor = 0;
    this.groupIndex = -1;
  }

  activeParticles(objectIndex: number): ActiveSkyEmitter[] {
    return [...this.active.values()].filter(value => value.objectIndex === objectIndex);
  }
}
