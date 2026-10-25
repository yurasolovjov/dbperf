// Each snapshot occupies one bucket. Missing buckets remain genuine gaps.
export function bucketAreaPath(
  timestamps: number[], top: number[], bottom: number[], step: number, end: number,
  x: (value: number) => number, y: (value: number) => number,
): string {
  const segments: number[][] = []
  timestamps.forEach((time, index) => {
    if (!index || time - timestamps[index - 1] > step * 1.5) segments.push([])
    segments[segments.length - 1].push(index)
  })
  const point = (time: number, value: number) => `${x(time).toFixed(1)},${y(value).toFixed(1)}`
  const right = (index: number) => Math.min(end, timestamps[index] + step, timestamps[index + 1] ?? end)
  return segments.map((indices) => {
    const upper = indices.flatMap((i) => [point(timestamps[i], top[i] ?? 0), point(right(i), top[i] ?? 0)])
    const lower = [...indices].reverse().flatMap((i) => [point(right(i), bottom[i] ?? 0), point(timestamps[i], bottom[i] ?? 0)])
    return `M${[...upper, ...lower].join(' L')} Z`
  }).join(' ')
}
