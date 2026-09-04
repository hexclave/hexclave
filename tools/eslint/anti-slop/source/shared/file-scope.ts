/** Test files exercise external payloads and intentionally use narrow casts in assertions. */
export function isTestFilename(filename: string): boolean {
	return /(?:^|[\\/])(?:tests?|__tests__|fixtures?|__fixtures__)(?:[\\/])|\.spec\.|\.tests?\./u.test(filename);
}

/** Generated platform mirrors are checked through packages/template instead of once per copy. */
export function isGeneratedSdkSource(sourceText: string): boolean {
	return sourceText.includes("THIS FILE IS AUTO-GENERATED FROM TEMPLATE");
}
