/**
 * The Source tab's file listing, as a folder tree.
 *
 * The manifest arrives flat and largest-first — a good answer to "which single
 * file is huge", a poor one to "which part of my tree is huge", which is the
 * question a surprising upload usually provokes (a stray `node_modules`, a
 * committed build output). Grouping the same rows by folder answers both: every
 * level is still ordered largest-first, so the first row of each level is still
 * the biggest thing in it — only now a folder can BE that row.
 */

export type SourceTreeNode =
  | { kind: "file", name: string, path: string, bytes: number }
  | {
    kind: "directory",
    /** The segment(s) this row shows. A chain of single-child folders is
     * collapsed into one row (`src/components/ui`), the way every file browser
     * that deals with deep trees does — three rows that can only be opened in
     * sequence carry no more information than one. */
    name: string,
    /** Full path from the service's root, no trailing slash. Identity for the
     * expand/collapse set, so it must survive a chain collapse — it is the
     * DEEPEST folder of the chain, which is the one whose children are shown. */
    path: string,
    bytes: number,
    fileCount: number,
    children: SourceTreeNode[],
  };


export type SourceTreeDirectory = Extract<SourceTreeNode, { kind: "directory" }>;

// Largest first, then by name so equal sizes (very common: empty files, small
// configs) do not reorder between renders.
function compareNodes(a: SourceTreeNode, b: SourceTreeNode): number {
  if (a.bytes !== b.bytes) return b.bytes - a.bytes;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return 0;
}

type MutableDirectory = {
  name: string,
  path: string,
  bytes: number,
  fileCount: number,
  directories: Map<string, MutableDirectory>,
  files: { name: string, path: string, bytes: number }[],
};

function newDirectory(name: string, path: string): MutableDirectory {
  return { name, path, bytes: 0, fileCount: 0, directories: new Map(), files: [] };
}

function childrenOf(directory: MutableDirectory): SourceTreeNode[] {
  return [
    ...[...directory.directories.values()].map(finalize),
    ...directory.files.map((file): SourceTreeNode => ({ kind: "file", name: file.name, path: file.path, bytes: file.bytes })),
  ].sort(compareNodes);
}

function finalize(directory: MutableDirectory): SourceTreeDirectory {
  let name = directory.name;
  let current = directory;
  // Collapse a chain of folders that each hold exactly one folder and no files.
  // The resulting row keeps the DEEPEST path, so expanding it reveals the
  // children actually listed under the collapsed name.
  while (current.files.length === 0 && current.directories.size === 1) {
    const [only] = [...current.directories.values()];
    name = `${name}/${only.name}`;
    current = only;
  }
  return { kind: "directory", name, path: current.path, bytes: directory.bytes, fileCount: directory.fileCount, children: childrenOf(current) };
}

/**
 * Groups manifest entries into a tree.
 *
 * `prefix` is the service's root directory as a path prefix (`"web/"`, or `""`
 * for the whole upload); entry paths still carry it, and the tree is rooted
 * BELOW it — a service's own tree should not open with the folder it is.
 * Entries outside the prefix are ignored, matching the slice the caller made.
 */
export function buildSourceTree(entries: { path: string, bytes: number }[], prefix: string): SourceTreeNode[] {
  const root = newDirectory("", "");
  for (const entry of entries) {
    if (prefix !== "" && !entry.path.startsWith(prefix)) continue;
    const relative = entry.path.slice(prefix.length);
    // Defensive: a manifest is a JSON column written by a client, so a path may
    // be empty, absolute, or hold `//`. Empty segments are dropped rather than
    // turned into nameless rows.
    const segments = relative.split("/").filter((segment) => segment !== "");
    if (segments.length === 0) continue;
    let directory = root;
    directory.bytes += entry.bytes;
    directory.fileCount += 1;
    for (let index = 0; index < segments.length - 1; index++) {
      const segment = segments[index];
      const path = directory.path === "" ? segment : `${directory.path}/${segment}`;
      let child = directory.directories.get(segment);
      if (child === undefined) {
        child = newDirectory(segment, path);
        directory.directories.set(segment, child);
      }
      child.bytes += entry.bytes;
      child.fileCount += 1;
      directory = child;
    }
    const name = segments[segments.length - 1];
    directory.files.push({ name, path: directory.path === "" ? name : `${directory.path}/${name}`, bytes: entry.bytes });
  }
  // childrenOf, not finalize: the root has no row of its own, so collapsing a
  // chain INTO it would drop a level the reader would otherwise see.
  return childrenOf(root);
}

/** Every folder path in the tree — what "expand all" expands to. */
export function allDirectoryPaths(nodes: SourceTreeNode[]): string[] {
  return nodes.flatMap((node) => node.kind === "directory" ? [node.path, ...allDirectoryPaths(node.children)] : []);
}

/** A node and its children flattened into the rows to render, in display order. */
export function visibleRows(nodes: SourceTreeNode[], expanded: Set<string>, depth = 0): { node: SourceTreeNode, depth: number }[] {
  return nodes.flatMap((node) => {
    const row = { node, depth };
    if (node.kind === "directory" && expanded.has(node.path)) {
      return [row, ...visibleRows(node.children, expanded, depth + 1)];
    }
    return [row];
  });
}

import.meta.vitest?.test("buildSourceTree groups by folder, largest first at every level", ({ expect }) => {
  const tree = buildSourceTree([
    { path: "src/big.ts", bytes: 500 },
    { path: "src/small.ts", bytes: 10 },
    { path: "package.json", bytes: 100 },
    { path: "public/img/a.png", bytes: 900 },
  ], "");
  expect(tree.map((node) => [node.name, node.bytes])).toEqual([
    // `public/img` is a chain of single-child folders, shown as one row.
    ["public/img", 900],
    ["src", 510],
    ["package.json", 100],
  ]);
  const src = tree[1];
  expect(src.kind === "directory" && src.children.map((child) => child.name)).toEqual(["big.ts", "small.ts"]);
  expect(src.kind === "directory" && src.fileCount).toBe(2);
});

import.meta.vitest?.test("buildSourceTree roots the tree below the service's prefix", ({ expect }) => {
  const entries = [{ path: "web/src/a.ts", bytes: 5 }, { path: "api/b.ts", bytes: 7 }];
  const tree = buildSourceTree(entries, "web/");
  expect(tree.map((node) => node.name)).toEqual(["src"]);
  expect(tree[0].path).toBe("src");
  // A folder holding one FILE is not a chain — only folder-in-folder collapses.
  expect(buildSourceTree(entries, "").map((node) => node.name)).toEqual(["api", "web/src"]);
});

import.meta.vitest?.test("a collapsed chain keeps the deepest path, so expanding it shows its children", ({ expect }) => {
  const [node] = buildSourceTree([{ path: "a/b/c/one.ts", bytes: 1 }, { path: "a/b/c/two.ts", bytes: 2 }], "");
  expect(node.name).toBe("a/b/c");
  expect(node.path).toBe("a/b/c");
  expect(visibleRows([node], new Set(["a/b/c"])).map((row) => row.node.name)).toEqual(["a/b/c", "two.ts", "one.ts"]);
});

import.meta.vitest?.test("buildSourceTree drops empty segments rather than rendering nameless rows", ({ expect }) => {
  expect(buildSourceTree([{ path: "/a//b.ts", bytes: 1 }, { path: "", bytes: 2 }, { path: "/", bytes: 3 }], "")).toEqual([
    { kind: "directory", name: "a", path: "a", bytes: 1, fileCount: 1, children: [{ kind: "file", name: "b.ts", path: "a/b.ts", bytes: 1 }] },
  ]);
});

import.meta.vitest?.test("visibleRows renders only what is expanded, depth-first", ({ expect }) => {
  const tree = buildSourceTree([{ path: "a/one.ts", bytes: 2 }, { path: "b.ts", bytes: 1 }], "");
  expect(visibleRows(tree, new Set()).map((row) => [row.node.name, row.depth])).toEqual([["a", 0], ["b.ts", 0]]);
  expect(visibleRows(tree, new Set(["a"])).map((row) => [row.node.name, row.depth])).toEqual([["a", 0], ["one.ts", 1], ["b.ts", 0]]);
  expect(allDirectoryPaths(tree)).toEqual(["a"]);
});
