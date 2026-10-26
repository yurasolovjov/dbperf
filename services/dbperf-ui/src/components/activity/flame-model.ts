import type { Dimension, ProfileResponse } from '../../api/types'

// A flame graph node: one value of one dimension level. The root (depth 0)
// stands for the whole window; every path of the profile response becomes a
// chain root → values[0] → values[1] → … with samples added along the way.
export interface FlameNode {
  key: string // identifies the node among its siblings (REST for a remainder)
  value: string
  samples: number
  depth: number
  parent: FlameNode | null
  children: FlameNode[]
  remainder: boolean
}

export const REST = '\u0000rest'
export const COLLAPSE_SHARE = 0.01

export function buildTree(data: ProfileResponse): FlameNode {
  const root: FlameNode = { key: '', value: '', samples: data.totalSamples, depth: 0, parent: null, children: [], remainder: false }
  const index = new Map<FlameNode, Map<string, FlameNode>>()
  for (const p of data.paths) {
    let node = root
    for (const v of p.values) {
      let byValue = index.get(node)
      if (!byValue) {
        byValue = new Map()
        index.set(node, byValue)
      }
      let child = byValue.get(v)
      if (!child) {
        child = { key: v, value: v, samples: 0, depth: node.depth + 1, parent: node, children: [], remainder: false }
        byValue.set(v, child)
        node.children.push(child)
      }
      child.samples += p.samples
      node = child
    }
  }
  sortChildren(root)
  return root
}

function sortChildren(node: FlameNode) {
  node.children.sort((a, b) => b.samples - a.samples || a.value.localeCompare(b.value))
  node.children.forEach(sortChildren)
}

// collapse folds siblings narrower than minSamples into one "остальные" node
// per parent, so a wide window with thousands of distinct queries still reads.
export function collapse(node: FlameNode, minSamples: number, parent: FlameNode | null = null): FlameNode {
  const copy: FlameNode = { ...node, parent, children: [] }
  let rest = 0
  for (const child of node.children) {
    if (child.samples < minSamples && !child.remainder) rest += child.samples
    else copy.children.push(collapse(child, minSamples, copy))
  }
  if (rest > 0)
    copy.children.push({ key: REST, value: '', samples: rest, depth: node.depth + 1, parent: copy, children: [], remainder: true })
  return copy
}

export function find(root: FlameNode, path: string[]): FlameNode | null {
  let node = root
  for (const key of path) {
    const child = node.children.find((c) => c.key === key)
    if (!child) return null
    node = child
  }
  return node
}

export function pathOf(node: FlameNode): string[] {
  const keys: string[] = []
  for (let n: FlameNode | null = node; n && n.parent; n = n.parent) keys.unshift(n.key)
  return keys
}

export function nodeLabel(node: FlameNode, dimensions: Dimension[], queryShortTexts: Record<string, string>): string {
  if (node.depth === 0) return 'Вся активность'
  if (node.remainder) return 'остальные'
  if (dimensions[node.depth - 1] === 'QUERY') return queryShortTexts[node.value] ?? `#${node.value}`
  return node.value || '(пусто)'
}

// Where the wait colour comes from: the node's own wait level, or the nearest
// wait-type ancestor, so a query level under "Lock" stays red.
export function waitTypeOf(node: FlameNode, dimensions: Dimension[]): string | null {
  for (let n: FlameNode | null = node; n && n.depth > 0; n = n.parent) {
    if (n.remainder) continue
    const dim = dimensions[n.depth - 1]
    if (dim === 'WAIT_EVENT_TYPE') return n.value
    if (dim === 'WAIT_EVENT') return n.value.split('.')[0]
  }
  return null
}

export interface Box {
  node: FlameNode
  left: number // 0..1 of the displayed root
  width: number
}

// layout places the displayed root at full width and every descendant under
// its parent, left to right in order of size.
export function layout(root: FlameNode): Box[] {
  const boxes: Box[] = []
  const walk = (node: FlameNode, left: number, width: number) => {
    boxes.push({ node, left, width })
    let x = left
    for (const child of node.children) {
      const w = root.samples ? (child.samples / root.samples) : 0
      walk(child, x, w)
      x += w
    }
  }
  walk(root, 0, 1)
  return boxes
}

// searchMatches returns the matching nodes without their matching descendants,
// so the summed share counts every snapshot once.
export function searchMatches(root: FlameNode, query: string, label: (n: FlameNode) => string): FlameNode[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const out: FlameNode[] = []
  const walk = (node: FlameNode) => {
    if (node.depth > 0 && !node.remainder && (label(node).toLowerCase().includes(q) || node.value.toLowerCase().includes(q))) {
      out.push(node)
      return
    }
    node.children.forEach(walk)
  }
  walk(root)
  return out
}
