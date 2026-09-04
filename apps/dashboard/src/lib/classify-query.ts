/**
 * Classifies whether user input is a ClickHouse SQL query or a natural language prompt.
 * Used to prioritize "Run Query" vs "Ask AI" in the command center.
 *
 * @param input - The user's input string
 * @param options.readonlyOnly - If true, only readonly queries (SELECT, SHOW, DESCRIBE, EXPLAIN) are considered SQL.
 *                               Mutating statements (INSERT, UPDATE, DELETE, etc.) are treated as prompts.
 */
export function classifyClickHouseSqlVsPrompt(
  input: string | null | undefined,
  options: { readonlyOnly?: boolean } = {}
): {
  kind: "sql" | "prompt",
  confidence: number,
  reasons: string[],
  score?: { sql: number, prompt: number, margin: number },
} {
  const { readonlyOnly = false } = options;
  const raw = (input ?? "").toString();
  const s = raw.trim();

  if (!s) {
    return { kind: "prompt", confidence: 0.5, reasons: ["empty"] };
  }

  // Strip code fences if someone pasted markdown
  const unfenced = s.replace(/^```[\w-]*\n([\s\S]*?)\n```$/m, "$1").trim();

  const lower = unfenced.toLowerCase();
  const words = lower.match(/[a-z_]+/g) ?? [];
  const wordSet = new Set(words);

  let sql = 0;
  let prompt = 0;
  const reasons: string[] = [];

  // Helper: check if keyword appears in UPPERCASE (stronger signal)
  const hasUppercaseKeyword = (keyword: string) => {
    const regex = new RegExp(`\\b${keyword.toUpperCase()}\\b`);
    return regex.test(unfenced);
  };

  // Define readonly vs mutating keywords
  const readonlyKeywords = ["select", "show", "describe", "desc", "explain", "with"];
  const mutatingKeywords = ["insert", "update", "delete", "alter", "create", "drop", "truncate", "use", "set"];

  // 1) Check for mutating statements when in readonly mode
  const startsWithMutating = new RegExp(`^(${mutatingKeywords.join("|")})\\b`, "i").test(unfenced);
  if (readonlyOnly && startsWithMutating) {
    // In readonly mode, mutating statements are not valid SQL for our purposes
    prompt += 4;
    reasons.push("mutating-statement-in-readonly-mode");
  }

  // 2) Strong starts - uppercase keywords are much stronger signals
  const readonlyStartRegex = new RegExp(`^(${readonlyKeywords.join("|")})\\b`, "i");
  const startsWithReadonly = readonlyStartRegex.test(unfenced);

  const allSqlKeywords = readonlyOnly ? readonlyKeywords : [...readonlyKeywords, ...mutatingKeywords];
  const sqlStartRegex = new RegExp(`^(${allSqlKeywords.join("|")})\\b`, "i");
  const startsWithSqlKeyword = sqlStartRegex.test(unfenced);

  // SHOW special handling - "show me" is English, "SHOW TABLES" is SQL
  const showEnglishLead = /^show\s+(me|us|my|our|your|them|him|her)\b/i.test(unfenced);
  const showHasSqlTarget = /^show\s+(tables?|databases?|columns?|create|processlist|functions?|settings|grants|roles|quotas|dictionary|dictionaries|clusters|indexes|partitions|privileges|users?)\b/i.test(unfenced);
  const startsWithShowSql = /^show\b/i.test(unfenced) && showHasSqlTarget && !showEnglishLead;

  // Extra points for SHOW/DESCRIBE commands that clearly target SQL objects
  if (startsWithShowSql) {
    sql += hasUppercaseKeyword("SHOW") ? 3 : 1;
    reasons.push("show-sql-target");
  }

  const startsWithSql = (startsWithSqlKeyword && !startsWithMutating) || startsWithShowSql ||
    (startsWithMutating && !readonlyOnly);

  if (startsWithSql) {
    // Uppercase start is much stronger
    const firstWord = unfenced.split(/\s+/)[0];
    if (firstWord === firstWord.toUpperCase() && /^[A-Z]+$/.test(firstWord)) {
      sql += 4;
      reasons.push("starts-with-uppercase-sql-keyword");
    } else {
      sql += 1; // Lowercase start is weak - could be English
      reasons.push("starts-with-lowercase-sql-keyword");
    }
  }

  // 3) Structural patterns - these are strong signals
  // SELECT ... FROM pattern - but check for SQL-like structure vs English
  const selectFromMatch = /\bselect\b([\s\S]{0,300})\bfrom\b/i.exec(unfenced);
  if (selectFromMatch) {
    const between = selectFromMatch[1];
    // Check for SQL-specific patterns between SELECT and FROM
    const hasStar = /\*/.test(between);
    const hasComma = /,/.test(between);
    const hasDotNotation = /\w+\.\w+/.test(between);
    const hasFunction = /\w+\s*\(/.test(between);
    const isUppercase = /\bSELECT\b/.test(unfenced) && /\bFROM\b/.test(unfenced);

    if (hasStar || hasDotNotation || hasFunction || isUppercase) {
      sql += isUppercase ? 5 : 3;
      reasons.push("select-from-structure-with-sql-syntax");
    } else if (hasComma) {
      sql += 2;
      reasons.push("select-from-structure-with-comma");
    } else {
      // "select all events from the table" - looks like English
      sql += 1;
      prompt += 2;
      reasons.push("select-from-looks-like-english");
    }
  }

  // INSERT INTO pattern (only if not readonly mode)
  if (!readonlyOnly) {
    const hasInsertInto = /\binsert\b[\s\S]{0,80}\binto\b/i.test(unfenced);
    if (hasInsertInto) {
      const isUppercase = /\bINSERT\b/.test(unfenced) && /\bINTO\b/.test(unfenced);
      sql += isUppercase ? 5 : 3;
      reasons.push("insert-into-structure");
    }
  }

  // 4) SQL-specific operators and punctuation (rare in English)
  // * is very SQL-specific when not preceded by space (not "user * activity")
  const hasSqlStar = /SELECT\s+\*|,\s*\*|^\s*\*\s*,|\w\.\*/.test(unfenced);
  if (hasSqlStar) {
    sql += 3;
    reasons.push("sql-star-operator");
  }

  // Dot notation without space after (table.column) - very SQL
  const dotNotationCount = (unfenced.match(/\b\w+\.\w+\b/g) ?? []).length;
  if (dotNotationCount >= 2) {
    sql += 3;
    reasons.push("multiple-dot-notations");
  } else if (dotNotationCount === 1) {
    sql += 1;
    reasons.push("dot-notation");
  }

  // Comparison operators with = (rare in natural language)
  const hasEquals = /[^!<>=]=[^=]/.test(unfenced);
  const hasComparison = /(<=|>=|!=|<>)/.test(unfenced);
  if (hasComparison) {
    sql += 3;
    reasons.push("sql-comparison-operators");
  } else if (hasEquals) {
    sql += 2;
    reasons.push("equals-operator");
  }

  // Parentheses with content (function calls, subqueries)
  const parenContent = unfenced.match(/\w+\s*\([^)]+\)/g) ?? [];
  if (parenContent.length >= 2) {
    sql += 2;
    reasons.push("multiple-function-calls");
  } else if (parenContent.length === 1) {
    sql += 1;
    reasons.push("function-call");
  }

  // Semicolon at end - very SQL
  if (/;\s*$/.test(unfenced)) {
    sql += 2;
    reasons.push("ends-with-semicolon");
  }

  // 5) SQL clauses - uppercase is stronger
  const clauses = ["where", "group", "order", "limit", "having", "join", "union", "distinct", "format", "settings"];
  const clauseHits: string[] = [];
  let uppercaseClauseCount = 0;
  for (const clause of clauses) {
    if (wordSet.has(clause)) {
      clauseHits.push(clause);
      if (hasUppercaseKeyword(clause)) {
        uppercaseClauseCount++;
      }
    }
  }
  if (clauseHits.length) {
    // Uppercase clauses are much stronger
    sql += uppercaseClauseCount * 2 + Math.min(2, clauseHits.length - uppercaseClauseCount);
    reasons.push(`sql-clauses:${clauseHits.join(",")}`);
    if (uppercaseClauseCount > 0) {
      reasons.push(`uppercase-clauses:${uppercaseClauseCount}`);
    }
  }

  // 6) ClickHouse-specific tokens
  const chTokens = [
    "prewhere", "final", "sample", "engine", "partition", "ttl", "distributed", "merge", "replacing", "collapsing",
    "materialized", "interval"
  ];
  const chHits = chTokens.filter(k => wordSet.has(k));
  if (chHits.length) {
    sql += chHits.length >= 2 ? 3 : 2;
    reasons.push("clickhouse-ish:" + chHits.join(","));
  }

  // 7) Quoted identifiers (very SQL-specific)
  if (/`[^`]+`/.test(unfenced)) {
    sql += 2;
    reasons.push("backtick-identifiers");
  }
  if (/"[^"]+"/.test(unfenced) && !/"\s/.test(unfenced)) {
    sql += 1;
    reasons.push("quoted-identifiers");
  }

  // SQL comments
  if (/--|\/\*/.test(unfenced)) {
    sql += 2;
    reasons.push("sql-comments");
  }

  // ===== PROMPT SIGNALS =====

  // Question mark at end - strong prompt signal
  if (/[?]\s*$/.test(unfenced)) {
    prompt += 3;
    reasons.push("ends-with-question-mark");
  }

  // Conversational/prompt words
  const promptWords = ["please", "could", "can", "would", "what", "why", "how", "explain", "help", "tell", "show me", "get me", "find me", "give me"];
  const promptWordHits = promptWords.filter(w => lower.includes(w));
  if (promptWordHits.length) {
    prompt += Math.min(4, promptWordHits.length * 2);
    reasons.push("prompt-words:" + promptWordHits.join(","));
  }

  // Articles and prepositions common in English but rare in SQL
  const englishWords = ["the", "a", "an", "all", "some", "any", "every", "each", "this", "that", "these", "those"];
  const englishHits = englishWords.filter(w => wordSet.has(w));
  if (englishHits.length >= 2) {
    prompt += 2;
    reasons.push("english-articles");
  }

  // Low symbol density with no SQL operators = likely English
  // But don't penalize short SQL commands like "SHOW TABLES" or "DESCRIBE events"
  const symbolChars = (unfenced.match(/[^a-z0-9_\s]/gi) ?? []).length;
  const symbolRatio = symbolChars / Math.max(1, unfenced.length);
  const hasSqlOperators = hasEquals || hasComparison || hasSqlStar || dotNotationCount > 0;
  const isShortCommand = words.length <= 3;

  if (symbolRatio < 0.04 && !hasSqlOperators && !startsWithSql) {
    prompt += 3;
    reasons.push("low-symbol-no-operators");
  } else if (symbolRatio < 0.08 && !hasSqlOperators && !startsWithSql && !isShortCommand) {
    prompt += 2;
    reasons.push("low-symbol-density");
  }

  // "select" followed by English words without SQL structure
  if (/^select\b/i.test(unfenced) && !selectFromMatch) {
    prompt += 4;
    reasons.push("select-without-from");
  } else if (/^select\b/i.test(unfenced) && selectFromMatch && !hasSqlStar && dotNotationCount === 0 && !hasEquals) {
    // "select all events from the table from the last 24 hours" - very English-like
    const hasEnglishPattern = /\bfrom the\b|\bin the\b|\bof the\b|\bfor the\b/i.test(unfenced);
    if (hasEnglishPattern) {
      prompt += 4;
      reasons.push("english-phrase-pattern");
    }
  }

  // Long sentences without SQL structure are likely prompts
  const wordCount = words.length;
  if (wordCount > 10 && !hasSqlOperators && clauseHits.length <= 1) {
    prompt += 2;
    reasons.push("long-sentence-no-sql-structure");
  }

  // ===== FINAL SCORING =====

  const margin = sql - prompt;
  // Require a higher margin to classify as SQL (when in doubt, prefer prompt)
  const kind = margin >= 3 ? "sql" : "prompt";

  // Confidence: squish margin into [0.5..0.99]
  const confidence = Math.max(0.5, Math.min(0.99, 0.5 + Math.abs(margin) * 0.08));

  return { kind, confidence, reasons, score: { sql, prompt, margin } };
}
