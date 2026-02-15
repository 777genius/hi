/**
 * Источник данных для AudioVisualizer на основе уровня теста системного звука.
 */

import { listen, type UnlistenFn } from '@tauri-apps/api/event';
import type { AudioVisualizerSource } from '../../../../composables/useAudioVisualizer';

const BAR_COUNT = 48;

type LevelPayload = {
  level: number;
};

export class SystemTestAudioSource implements AudioVisualizerSource {
  private unlisten: UnlistenFn | null = null;
  private readonly phases = Array.from(
    { length: BAR_COUNT },
    (_, i) => (i / BAR_COUNT) * Math.PI * 2 + Math.random() * 0.5
  );

  async start(onBars: (bars: number[]) => void): Promise<void> {
    if (this.unlisten) return;

    this.unlisten = await listen<LevelPayload>('system_audio_test:level', (event) => {
      const level = Math.min(1, Math.max(0, event.payload?.level ?? 0));
      onBars(this.levelToBars(level));
    });
  }

  stop(): void {
    if (!this.unlisten) return;
    this.unlisten();
    this.unlisten = null;
  }

  private levelToBars(level: number): number[] {
    const t = performance.now() / 1000;
    const bars: number[] = new Array(BAR_COUNT);
    const center = (BAR_COUNT - 1) / 2;

    for (let i = 0; i < BAR_COUNT; i++) {
      const dist = Math.abs(i - center) / center;
      const envelope = Math.exp(-dist * dist * 2.5);
      const wave = 0.7 + 0.3 * Math.sin(t * 3.5 + this.phases[i]);
      bars[i] = Math.min(1, level * envelope * wave);
    }

    return bars;
  }
}

