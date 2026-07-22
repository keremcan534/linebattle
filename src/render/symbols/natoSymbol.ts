import { Graphics } from 'pixi.js';
import type { Branch } from '@core/world/division';

/**
 * APP-6 style unit counters.
 *
 * Placeholder art as requested — but placeholder in *fidelity*, not in
 * structure: the symbol is generated procedurally from the division's branch,
 * so swapping in proper sprites later means replacing this one function and
 * nothing else. The counter is drawn in a local pixel-sized space centred on
 * the origin; the unit layer counter-scales it so it stays legible at any zoom.
 */
export function drawUnitCounter(
  g: Graphics,
  branch: Branch,
  width: number,
  height: number,
  fill: number,
  outline: number,
): void {
  const hw = width / 2;
  const hh = height / 2;

  g.rect(-hw, -hh, width, height)
    .fill({ color: fill, alpha: 0.92 })
    .stroke({ width: 1.5, color: outline, alpha: 1 });

  drawBranchDevice(g, branch, hw, hh, outline);
}

function drawBranchDevice(g: Graphics, branch: Branch, hw: number, hh: number, ink: number): void {
  // Inset so the device never touches the frame.
  const x = hw * 0.78;
  const y = hh * 0.72;
  const line = { width: 1.4, color: ink, alpha: 0.95 } as const;

  const cross = () => {
    g.moveTo(-x, -y).lineTo(x, y).moveTo(-x, y).lineTo(x, -y).stroke(line);
  };
  const oval = () => {
    g.ellipse(0, 0, x * 0.85, y * 0.8).stroke(line);
  };

  switch (branch) {
    case 'infantry':
      cross();
      break;

    case 'armoured':
      oval();
      break;

    case 'mechanised':
      cross();
      oval();
      break;

    case 'motorised':
      cross();
      g.circle(0, y * 0.55, y * 0.22).fill({ color: ink });
      break;

    case 'cavalry':
      g.moveTo(-x, y).lineTo(x, -y).stroke(line);
      break;

    case 'mountain':
      cross();
      g.moveTo(-x * 0.45, y * 0.9).lineTo(0, y * 0.25).lineTo(x * 0.45, y * 0.9).stroke(line);
      break;

    case 'airborne':
      cross();
      g.moveTo(-x, -y * 0.15)
        .arc(0, -y * 0.15, x, Math.PI, 0)
        .stroke(line);
      break;

    case 'artillery':
      g.circle(0, 0, Math.min(x, y) * 0.4).fill({ color: ink });
      break;

    case 'security':
      cross();
      g.moveTo(0, -y).lineTo(0, y).stroke(line);
      break;
  }
}

/** The "XX" echelon marker that identifies a formation as a division. */
export function drawEchelon(g: Graphics, height: number, ink: number): void {
  const y = -height / 2 - 4;
  const s = 3;
  g.moveTo(-s * 2, y - s).lineTo(-s, y + s)
    .moveTo(-s, y - s).lineTo(-s * 2, y + s)
    .moveTo(s, y - s).lineTo(s * 2, y + s)
    .moveTo(s * 2, y - s).lineTo(s, y + s)
    .stroke({ width: 1.2, color: ink, alpha: 0.9 });
}
