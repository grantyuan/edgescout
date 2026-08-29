"use client";

// ---------------------------------------------------------------------------
// CandleChart — dependency-free SVG candlestick chart + settlement reference
// line. Used in the agent report panel to visualize the model's inputs.
// ---------------------------------------------------------------------------

export type Candle = [number, number, number, number, number, number];

interface Props {
  candles: Candle[];
  /** Settlement reference: strike for strike markets, window open for up/down. */
  refPrice: number | null;
  refLabel?: string;
  height?: number;
}

export default function CandleChart({ candles, refPrice, refLabel = "ref", height = 160 }: Props) {
  if (candles.length === 0) {
    return (
      <div className="text-zinc-500 text-xs h-24 flex items-center justify-center border border-zinc-800 rounded">
        Loading chart data…
      </div>
    );
  }
  const W = 600;
  const H = height;
  const padL = 8;
  const padR = 8;
  const padT = 10;
  const padB = 16;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;

  let min = Infinity;
  let max = -Infinity;
  for (const c of candles) {
    min = Math.min(min, c[3]);
    max = Math.max(max, c[2]);
  }
  if (refPrice != null) {
    min = Math.min(min, refPrice);
    max = Math.max(max, refPrice);
  }
  const span = max - min || 1;
  min -= span * 0.05;
  max += span * 0.05;
  const span2 = max - min;

  const x = (i: number) => padL + (i + 0.5) * (plotW / candles.length);
  const y = (p: number) => padT + (1 - (p - min) / span2) * plotH;
  const bw = Math.max(2, (plotW / candles.length) * 0.65);

  const refY = refPrice != null ? y(refPrice) : null;

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="w-full border border-zinc-800 rounded bg-zinc-900/40"
      role="img"
      aria-label="candlestick chart"
    >
      {/* horizontal gridlines (4) */}
      {[0.25, 0.5, 0.75].map((f) => (
        <g key={f}>
          <line
            x1={padL}
            x2={W - padR}
            y1={padT + f * plotH}
            y2={padT + f * plotH}
            stroke="#27272a"
            strokeWidth="1"
          />
          <text
            x={W - padR - 2}
            y={padT + f * plotH - 3}
            fontSize="9"
            fill="#52525b"
            textAnchor="end"
          >
            {(min + f * span2).toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </text>
        </g>
      ))}
      {/* candles */}
      {candles.map((c, i) => {
        const [, o, h, l, cl] = c;
        const up = cl >= o;
        const color = up ? "#34d399" : "#f87171";
        const bodyTop = y(Math.max(o, cl));
        const bodyH = Math.max(1, Math.abs(y(o) - y(cl)));
        return (
          <g key={i}>
            <line x1={x(i)} x2={x(i)} y1={y(h)} y2={y(l)} stroke={color} strokeWidth="1" />
            <rect x={x(i) - bw / 2} y={bodyTop} width={bw} height={bodyH} fill={color} />
          </g>
        );
      })}
      {/* reference line */}
      {refY != null && (
        <g>
          <line
            x1={padL}
            x2={W - padR}
            y1={refY}
            y2={refY}
            stroke="#38bdf8"
            strokeWidth="1.5"
            strokeDasharray="6 4"
          />
          <text x={padL + 4} y={refY - 4} fontSize="10" fill="#38bdf8">
            {refLabel} {refPrice?.toLocaleString("en-US", { maximumFractionDigits: 2 })}
          </text>
        </g>
      )}
      {/* x labels: first / last timestamps */}
      <text x={padL} y={H - 4} fontSize="9" fill="#52525b">
        {new Date(candles[0][0]).toISOString().slice(11, 16)}
      </text>
      <text x={W - padR} y={H - 4} fontSize="9" fill="#52525b" textAnchor="end">
        {new Date(candles[candles.length - 1][0]).toISOString().slice(11, 16)}
      </text>
    </svg>
  );
}
