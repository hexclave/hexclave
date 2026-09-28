const INDEPENDENT_TV_DISPLAY_PATH = /^\/tv\/?$/;
const TV_PRESENTATION_PATH = /^\/projects\/[^/]+\/tv-mode\/present\/[^/]+\/?$/;

export function isIndependentTvDisplayPath(pathname: string): boolean {
  return INDEPENDENT_TV_DISPLAY_PATH.test(pathname);
}

export function isTvPresentationPath(pathname: string): boolean {
  return TV_PRESENTATION_PATH.test(pathname);
}
