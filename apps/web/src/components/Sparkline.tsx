interface Props {
  /** Oldest first. */
  values: number[];
  width?: number;
  height?: number;
  label: string;
}

/** A tiny trend line. The last point is marked; the whole thing is described for screen readers. */
export function Sparkline({ values, width = 160, height = 36, label }: Props) {
  if (values.length === 0) return null;
  const pad = 4;
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(1, max - min);
  const x = (i: number) =>
    values.length === 1 ? width / 2 : pad + (i * (width - 2 * pad)) / (values.length - 1);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - 2 * pad);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const last = values.length - 1;

  return (
    <svg
      className="sparkline"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={label}
    >
      {values.length > 1 && <polyline points={points} />}
      {values.map((v, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(v)}
          r={i === last ? 3.5 : 2}
          className={i === last ? "last" : undefined}
        />
      ))}
    </svg>
  );
}
