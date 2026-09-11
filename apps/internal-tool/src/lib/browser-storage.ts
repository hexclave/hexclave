
function isStorageUnavailable(error: unknown): boolean {
  return error instanceof DOMException;
}

export function readLocalStorage(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch (error) {
    if (isStorageUnavailable(error)) return null;
    throw error;
  }
}

export function writeLocalStorage(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch (error) {
    if (isStorageUnavailable(error)) return;
    throw error;
  }
}
