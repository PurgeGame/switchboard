// Machine-wide resource stats: CPU, memory, swap, PSI, GPU.
import { readFileSync } from "node:fs";
import { cpus } from "node:os";
import type { SystemStats } from "../shared/types.ts";

function readCpu(): { idle: number; total: number } {
  const line = readFileSync("/proc/stat", "utf8").split("\n")[0];
  const v = line.split(/\s+/).slice(1).map(Number);
  const idle = v[3] + (v[4] ?? 0);
  return { idle, total: v.reduce((a, b) => a + b, 0) };
}

function meminfo(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const l of readFileSync("/proc/meminfo", "utf8").split("\n")) {
    const m = l.match(/^(\w+):\s+(\d+)/);
    if (m) out[m[1]] = +m[2] / 1024; // MB
  }
  return out;
}

function psi(res: string): number {
  try {
    const m = readFileSync(`/proc/pressure/${res}`, "utf8").match(/some avg10=([\d.]+)/);
    return m ? +m[1] : 0;
  } catch {
    return 0;
  }
}

export class SystemMonitor {
  private prev = readCpu();
  private gpu: SystemStats["gpu"] = null;
  private gpuAt = 0;
  gameMode = false;

  private async readGpu() {
    try {
      const p = Bun.spawn(["nvidia-smi", "--query-gpu=name,memory.used,memory.total,utilization.gpu", "--format=csv,noheader,nounits"], { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(p.stdout).text();
      const [name, used, total, util] = out.trim().split("\n")[0].split(", ");
      this.gpu = name ? { name, memUsedMB: +used, memTotalMB: +total, utilPct: +util } : null;
    } catch {
      this.gpu = null;
    }
  }

  sample(): SystemStats {
    const now = Date.now();
    const cur = readCpu();
    const dt = cur.total - this.prev.total;
    const cpuPct = dt > 0 ? (1 - (cur.idle - this.prev.idle) / dt) * 100 : 0;
    this.prev = cur;
    if (now - this.gpuAt > 5000) {
      this.gpuAt = now;
      void this.readGpu();
    }
    const m = meminfo();
    return {
      ts: now,
      cpuPct: Math.round(cpuPct * 10) / 10,
      cores: cpus().length,
      memTotalMB: Math.round(m.MemTotal ?? 0),
      memAvailableMB: Math.round(m.MemAvailable ?? 0),
      swapUsedMB: Math.round((m.SwapTotal ?? 0) - (m.SwapFree ?? 0)),
      psi: { cpu: psi("cpu"), memory: psi("memory"), io: psi("io") },
      gpu: this.gpu,
      gameMode: this.gameMode,
    };
  }
}
