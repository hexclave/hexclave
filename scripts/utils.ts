import fs from "fs";
import path from "path";


export const COMMENT_LINE = "THIS FILE IS AUTO-GENERATED FROM TEMPLATE. DO NOT EDIT IT DIRECTLY UNLESS YOU ALSO EDIT THE CORRESPONDING FILE IN packages/template";
export const COMMENT_BLOCK = `\n//===========================================\n// ${COMMENT_LINE}\n//===========================================\n`

export const PLATFORMS = {
  "next": ['next', 'react-like', 'js-like'],
  "js": ['js', 'js-like'],
  "react": ['react', 'react-like', 'js-like'],
  "tanstack-start": ['tanstack-start', 'react', 'react-like', 'js-like'],
  "template": ['template', 'react-like', 'next', 'js', 'js-like', 'python-like', 'tanstack-start'],
  "python": ['python', 'python-like'],
}

export const withGeneratorLock = async <T>(fn: () => Promise<T>) => {
  const lockFilePath = path.resolve(import.meta.dirname, "../generator-lock-file.untracked.lock");
  while (true) {
    try {
      fs.writeFileSync(lockFilePath, Date.now().toString(), { flag: 'wx' });
      break;
    } catch (e) {
      if ("code" in e && e.code === "EEXIST") {
        const millis = +fs.readFileSync(lockFilePath, 'utf-8');
        if (Date.now() - millis > 5 * 60 * 1000) {
          console.warn(`Generator lock file ${lockFilePath} exists, but is older than 5 minutes. Assuming it's stale and deleting.`);
          fs.unlinkSync(lockFilePath);  // TODO: this should be done atomically
          await new Promise((resolve) => setTimeout(resolve, 5000));
          continue;
        } else {
          console.log(`Generator lock file ${lockFilePath} exists. Waiting for it to be released...`);
          await new Promise((resolve) => setTimeout(resolve, 2000 * Math.random()));
          continue;
        }
      } else {
        throw e;
      }
    }
  }
  try {
    return await fn();
  } finally {
    try {
      fs.unlinkSync(lockFilePath);
    } catch (e) {
      if ("code" in e && e.code === "ENOENT") {
        // Someone else already deleted the lock file, not sure why but let's keep going
        console.warn(`Generator lock file ${lockFilePath} already deleted by someone else, not sure why but let's keep going. You may want to investigate this.`);
        return;
      }
      throw e;
    }
  }
}

export function processMacros(content: string, platforms: string[]): string {
  const lines = content.split('\n');
  const result: string[] = [];

  // Each element in skipStack can be either:
  //
  // 1) A string like "NEXT_LINE", meaning skip exactly the next line.
  //
  // 2) An object of the form:
  //       { 
  //         type: 'IF_BLOCK',
  //         parentActive: boolean,
  //         hasMatched: boolean,
  //         isActive: boolean
  //       }
  //
  //    - parentActive = whether the block's parent is active. If false, this block can never produce output.
  //    - hasMatched   = if any branch in this block has matched so far (IF_PLATFORM or ELSE_IF).
  //    - isActive     = if the *current branch* in this block is active right now.
  //
  interface IFBlockState {
    type: 'IF_BLOCK';
    parentActive: boolean;
    hasMatched: boolean;
    isActive: boolean;
  }

  const skipStack: Array<string | IFBlockState> = [];

  /**
   * Returns the top IF_BLOCK on the stack or null if none.
   */
  function getCurrentIFBlock(): IFBlockState | null {
    for (let i = skipStack.length - 1; i >= 0; i--) {
      const top = skipStack[i];
      if (typeof top !== 'string' && top.type === 'IF_BLOCK') {
        return top;
      }
    }
    return null;
  }

  /**
   * Check if we should output the current line (based on skipStack).
   */
  function shouldOutputLine(): boolean {
    // If there's a "NEXT_LINE" on top, we skip this line.
    // (We'll remove that NEXT_LINE after we handle this line.)
    for (let i = skipStack.length - 1; i >= 0; i--) {
      if (skipStack[i] === 'NEXT_LINE') {
        return false;
      }
    }

    // If any IF_BLOCK up the stack is not active, or its parent is not active, we skip.
    for (let i = skipStack.length - 1; i >= 0; i--) {
      const top = skipStack[i];
      if (typeof top !== 'string' && top.type === 'IF_BLOCK') {
        if (!top.parentActive || !top.isActive) {
          return false;
        }
      }
    }

    return true;
  }

  /**
   * Consume a single-use "NEXT_LINE" skip once we've decided about output.
   */
  function consumeNextLineIfPresent() {
    const top = skipStack[skipStack.length - 1];
    if (top === 'NEXT_LINE') {
      skipStack.pop();
    }
  }

  /**
   * Parse platform tokens from a directive substring (the part after IF_PLATFORM, ELSE_IF_PLATFORM, etc.).
   * We do a basic split on whitespace, then remove punctuation except for letters/numbers/hyphens.
   */
  function parsePlatformList(platform: string): string[] {
    return platform
      .split(/\s+/)
      .map((e) => e.trim().toLowerCase().replace(/[^a-z0-9-]/g, ''))
      .filter(Boolean);
  }

  /**
   * We define flexible regexes that look for these directives *anywhere* in the line:
   *   - IF_PLATFORM
   *   - ELSE_IF_PLATFORM
   *   - ELSE_PLATFORM
   *   - END_PLATFORM
   *   - NEXT_LINE_PLATFORM
   *   - THIS_LINE_PLATFORM
   *
   * And then capture everything after that keyword up to the end of the line.
   *
   * Examples:
   *   "blah blah IF_PLATFORM platform1 platform2 ???"  => captures "platform1 platform2 ???"
   *   "adsfasdf ELSE_PLATFORM blabla"         => captures "blabla"
   */
  const reBeginOnly   = /\bIF_PLATFORM:?\s+(.+)/i;
  const reElseIf      = /\bELSE_IF_PLATFORM:?\s+(.+)/i;
  const reElse        = /\bELSE_PLATFORM\b/i;
  const reEndOnly     = /\bEND_PLATFORM\b/i;
  const reNextLine    = /\bNEXT_LINE_PLATFORM:?\s+(.+)/i;
  const reThisLine    = /\bTHIS_LINE_PLATFORM:?\s+(.+)/i;  // New regex

  for (const line of lines) {
    // 1) Try detecting IF_PLATFORM ...
    const beginMatch = line.match(reBeginOnly);
    if (beginMatch) {
      const parentBlock = getCurrentIFBlock();
      // If parentActive = false or isActive = false => entire sub-block is inactive
      const parentIsFullyActive =
        !parentBlock ? true : (parentBlock.parentActive && parentBlock.isActive);

      if (!parentIsFullyActive) {
        // Just push an inactive block so we handle nested macros correctly
        skipStack.push({
          type: 'IF_BLOCK',
          parentActive: false,
          hasMatched: false,
          isActive: false
        });
      } else {
        const platformList = parsePlatformList(beginMatch[1]); // e.g. "platform1 platform2 ???"
        const matched = platformList.some((e) => platforms.includes(e));
        skipStack.push({
          type: 'IF_BLOCK',
          parentActive: true,
          hasMatched: matched, 
          isActive: matched
        });
      }
      // Skip output of the directive line
      continue;
    }

    // 2) Try detecting ELSE_IF_PLATFORM ...
    const elseIfMatch = line.match(reElseIf);
    if (elseIfMatch) {
      const block = getCurrentIFBlock();
      if (block) {
        if (!block.parentActive) {
          // Parent block is inactive => do nothing
        } else {
          // If block.hasMatched is true, we've already used an if/else if
          // If not, we check if the platform matches
          if (block.hasMatched) {
            block.isActive = false;
          } else {
            const platformList = parsePlatformList(elseIfMatch[1]);
            const matched = platformList.some((e) => platforms.includes(e));
            if (matched) {
              block.hasMatched = true;
              block.isActive = true;
            } else {
              block.isActive = false;
            }
          }
        }
      }
      // Skip output
      continue;
    }

    // 3) Try detecting ELSE_PLATFORM ...
    const elseMatch = line.match(reElse);
    if (elseMatch) {
      const block = getCurrentIFBlock();
      if (block) {
        if (!block.parentActive) {
          // Still nothing
        } else {
          // If we haven't matched anything yet, now we become active
          if (!block.hasMatched) {
            block.hasMatched = true;
            block.isActive = true;
          } else {
            // Already matched something, so skip
            block.isActive = false;
          }
        }
      }
      // Skip line
      continue;
    }

    // 4) Try detecting END_PLATFORM ...
    const endMatch = line.match(reEndOnly);
    if (endMatch) {
      // Pop the top IF_BLOCK if it exists
      if (skipStack.length > 0) {
        const top = skipStack[skipStack.length - 1];
        if (top && typeof top !== 'string' && top.type === 'IF_BLOCK') {
          skipStack.pop();
        }
      }
      // Skip line
      continue;
    }

    // 5) Try detecting NEXT_LINE_PLATFORM ...
    const nextLineMatch = line.match(reNextLine);
    if (nextLineMatch) {
      const platformList = parsePlatformList(nextLineMatch[1]);
      const matched = platformList.some((e) => platforms.includes(e));
      if (!matched) {
        skipStack.push('NEXT_LINE');
      }
      // Skip line
      continue;
    }

    // 6) Try detecting THIS_LINE_PLATFORM ... (new behavior)
    const thisLineMatch = line.match(reThisLine);
    if (thisLineMatch) {
      const platformList = parsePlatformList(thisLineMatch[1]);
      const matched = platformList.some((e) => platforms.includes(e));
      if (matched) {
        // Output the line unchanged (including the directive itself)
        result.push(line);
      }
      // Whether matched or not, skip further processing of this line
      continue;
    }

    // If it's a normal line:
    if (shouldOutputLine()) {
      result.push(line);
    }

    // If the top of the stack is NEXT_LINE, consume it once
    consumeNextLineIfPresent();
  }

  return result.join('\n');
}
 
export function writeFileSyncIfChanged(path: string, content: string | Buffer): void {
  if (typeof content === 'string') {
    content = Buffer.from(content);
  }
  if (fs.existsSync(path)) {
    const existingContent = fs.readFileSync(path, { encoding: null });
    if (Buffer.compare(existingContent, content) === 0) {
      return;
    }
  }
  fs.writeFileSync(path, content);
}

/**
 * Recursively remove empty folders in the given directory.
 */
function removeEmptyFolders(dir: string) {
  if (!fs.existsSync(dir)) return;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  let isEmpty = true;

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      // Recursively remove empty subdirectories
      removeEmptyFolders(fullPath);

      // Check if the folder is now empty
      if (fs.existsSync(fullPath) && fs.readdirSync(fullPath).length === 0) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        isEmpty = false;
      }
    } else {
      // Directory contains at least one file
      isEmpty = false;
    }
  }

  // Remove the directory if it is empty
  if (isEmpty) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function copyFromSrcToDest(options: {
  srcDir: string;
  destDir: string;
  editFn?: (relativePath: string, content: string) => string;
  filterFn?: (relativePath: string) => boolean;
  destFn?: (relativePath: string) => string;
  destRemoveSkipFn?: (relativePath: string) => boolean;
  baseDir?: string;
  topLevel?: boolean;
}) {
  // Use srcDir as the default base directory so that relative paths are computed from the source root.
  const { 
    srcDir, 
    destDir, 
    editFn, 
    filterFn, 
    destFn, 
    destRemoveSkipFn,
    baseDir = srcDir,
    topLevel = true, 
  } = options;

  const entries = fs.readdirSync(srcDir, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const relativePath = path.relative(baseDir, srcPath);

    // Skip entry if filterFn returns false.
    if (filterFn && !filterFn(relativePath)) {
      continue;
    }

    const destRelativePath = destFn ? destFn(relativePath) : relativePath;
    const destPath = path.join(destDir, destRelativePath);
    const destParent = path.dirname(destPath);

    if (entry.isDirectory()) {
      // Optionally apply destFn to directories as well if provided.
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true });
      }

      copyFromSrcToDest({
        srcDir: srcPath,
        destDir: destDir,
        editFn,
        filterFn,
        destFn,
        baseDir,
        topLevel: false,
        destRemoveSkipFn,
      });
    } else {
      // Read file as a buffer so we can check if it’s binary.
      const buffer = fs.readFileSync(srcPath);
      const isBinary = buffer.includes(0);

      if (!fs.existsSync(destParent)) {
        fs.mkdirSync(destParent, { recursive: true });
      }

      if (isBinary) {
        writeFileSyncIfChanged(destPath, buffer);
      } else {
        // For text files, allow modification via editFn.
        const content = buffer.toString('utf-8');
        const result = editFn ? editFn(relativePath, content) : content;
        writeFileSyncIfChanged(destPath, result);
      }
    }
  }
  
  if (topLevel) {
    // Build the set of expected destination paths from the source.
    const expectedPaths = buildExpectedPaths(srcDir, baseDir, filterFn, destFn);
    // Remove extraneous files/folders from the destination.
    removeExtraneousFromDest(destDir, expectedPaths, destRemoveSkipFn);
    // Clean up any empty folders left in the destination.
    removeEmptyFolders(destDir);
  }
}

// Helper function to build a set of expected destination relative paths from the source.
function buildExpectedPaths(
  srcDir: string,
  baseDir: string,
  filterFn?: (relativePath: string) => boolean,
  destFn?: (relativePath: string) => string
): Set<string> {
  const expectedPaths = new Set<string>();

  function walk(currentSrcDir: string) {
    const entries = fs.readdirSync(currentSrcDir, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(currentSrcDir, entry.name);
      const relativePath = path.relative(baseDir, srcPath);
      if (filterFn && !filterFn(relativePath)) continue;
      const destRelativePath = destFn ? destFn(relativePath) : relativePath;
      expectedPaths.add(destRelativePath);
      if (entry.isDirectory()) {
        walk(srcPath);
      }
    }
  }

  walk(srcDir);
  return expectedPaths;
}

// Helper function to remove files and directories from the destination
// that are not present in the expectedPaths set.
function removeExtraneousFromDest(
  destDir: string,
  expectedPaths: Set<string>,
  destRemoveSkipFn?: (relativePath: string) => boolean
) {
  function walk(currentDestDir: string) {
    const entries = fs.readdirSync(currentDestDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDestDir, entry.name);
      // Compute the relative path with respect to destDir.
      const relativePath = path.relative(destDir, fullPath);
      // Skip paths that should not be removed.
      if (destRemoveSkipFn && destRemoveSkipFn(relativePath)) continue;
      if (!expectedPaths.has(relativePath)) {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        walk(fullPath);
      }
    }
  }

  walk(destDir);
}

