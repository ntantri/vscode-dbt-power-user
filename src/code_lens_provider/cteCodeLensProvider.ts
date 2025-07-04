import {
  CancellationToken,
  CodeLens,
  CodeLensProvider,
  Command,
  Range,
  TextDocument,
  Disposable,
} from "vscode";
import { provideSingleton } from "../utils";
import { DBTTerminal } from "../dbt_client/dbtTerminal";
import { AltimateRequest } from "../altimate";

export interface CteInfo {
  name: string;
  range: Range;
  queryRange: Range;
  index: number; // Order of CTE in the WITH clause
  withClauseStart: number; // Start position of the WITH clause
}

@provideSingleton(CteCodeLensProvider)
export class CteCodeLensProvider implements CodeLensProvider, Disposable {
  private disposables: Disposable[] = [];

  constructor(
    private dbtTerminal: DBTTerminal,
    private altimate: AltimateRequest,
  ) {}

  dispose() {
    while (this.disposables.length) {
      const x = this.disposables.pop();
      if (x) {
        x.dispose();
      }
    }
  }

  public provideCodeLenses(
    document: TextDocument,
    _token: CancellationToken,
  ): CodeLens[] | Thenable<CodeLens[]> {
    try {
      // Only provide code lenses for SQL files
      if (!document.languageId.includes("sql")) {
        this.dbtTerminal.debug(
          "CteCodeLensProvider",
          `Skipping non-SQL file: ${document.languageId}`,
        );
        return [];
      }

      // Check if Altimate API key is configured
      if (!this.altimate.enabled()) {
        this.dbtTerminal.debug(
          "CteCodeLensProvider",
          "Skipping CTE code lens - Altimate API key not configured",
        );
        return [];
      }

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Starting CTE detection for ${document.uri.fsPath}`,
      );

      const ctes = this.detectCtes(document);
      const codeLenses: CodeLens[] = [];

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Found ${ctes.length} CTEs in document`,
      );

      for (const cte of ctes) {
        const runCteCommand: Command = {
          title: `▶ Execute CTE: ${cte.name}`,
          command: "dbtPowerUser.runCteWithDependencies",
          arguments: [document.uri, cte.index, ctes],
        };

        const codeLens = new CodeLens(cte.range, runCteCommand);
        codeLenses.push(codeLens);

        this.dbtTerminal.debug(
          "CteCodeLensProvider",
          `Created code lens for CTE: ${cte.name} at index ${cte.index}`,
        );
      }

      return codeLenses;
    } catch (error) {
      this.dbtTerminal.error(
        "CteCodeLensProvider",
        "Error in provideCodeLenses",
        error,
      );
      return [];
    }
  }

  private detectCtes(document: TextDocument): CteInfo[] {
    const text = document.getText();
    const ctes: CteInfo[] = [];

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Document length: ${text.length} characters`,
    );

    // Find all WITH clauses
    const withClauseRegex = /\bwith\s+/gi;
    let withMatch;
    let withClauseCount = 0;

    while ((withMatch = withClauseRegex.exec(text)) !== null) {
      withClauseCount++;
      const withStartPos = withMatch.index + withMatch[0].length;

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Found WITH clause #${withClauseCount} at position ${withMatch.index}`,
      );

      // Find the end of this WITH clause (before the main SELECT)
      const withClauseEnd = this.findWithClauseEnd(text, withStartPos);
      if (withClauseEnd === -1) {
        this.dbtTerminal.warn(
          "CteCodeLensProvider",
          `Could not find end of WITH clause #${withClauseCount} starting at ${withStartPos}`,
        );
        continue;
      }

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `WITH clause #${withClauseCount} ends at position ${withClauseEnd}`,
      );

      // Extract the WITH clause content
      const withClauseContent = text.substring(withStartPos, withClauseEnd);

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `WITH clause content length: ${withClauseContent.length} characters`,
      );

      // Find all CTEs within this WITH clause
      const beforeCteCount = ctes.length;
      this.extractCtesFromWithClause(
        withClauseContent,
        withStartPos,
        withMatch.index,
        document,
        ctes,
      );

      const ctesFound = ctes.length - beforeCteCount;
      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Found ${ctesFound} CTEs in WITH clause #${withClauseCount}`,
      );
    }

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Total WITH clauses found: ${withClauseCount}, Total CTEs found: ${ctes.length}`,
    );

    return ctes;
  }

  /**
   * Helper function to handle SQL string literal parsing with proper quote escaping
   * Returns updated position and string state
   */
  private handleSqlStringLiteral(
    text: string,
    pos: number,
    inString: boolean,
    stringChar: string,
  ): { newPos: number; inString: boolean; stringChar: string } {
    const char = text[pos];
    const nextChar = pos < text.length - 1 ? text[pos + 1] : "";

    // Handle string literals with SQL-style quote escaping
    if (!inString && (char === "'" || char === '"')) {
      return {
        newPos: pos,
        inString: true,
        stringChar: char,
      };
    } else if (inString && char === stringChar) {
      // Check for doubled quotes (SQL escape sequence)
      if (nextChar === stringChar) {
        // This is an escaped quote - skip the next character
        this.dbtTerminal.debug(
          "CteCodeLensProvider",
          `Found escaped quote (${stringChar}${stringChar}) at position ${pos}`,
        );
        return {
          newPos: pos + 1, // Skip the second quote
          inString: true,
          stringChar: stringChar,
        };
      } else {
        // This is the end of the string
        return {
          newPos: pos,
          inString: false,
          stringChar: "",
        };
      }
    }

    return { newPos: pos, inString, stringChar };
  }

  private findWithClauseEnd(text: string, withStartPos: number): number {
    // Look for the main SELECT that comes after all CTEs
    // This is a simplified approach - we look for SELECT that's not inside parentheses
    let pos = withStartPos;
    let parenCount = 0;
    let inString = false;
    let stringChar = "";
    let selectsChecked = 0;

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Searching for WITH clause end starting at position ${withStartPos}`,
    );

    while (pos < text.length) {
      const char = text[pos];

      // Handle string literals using helper function
      const stringResult = this.handleSqlStringLiteral(
        text,
        pos,
        inString,
        stringChar,
      );
      pos = stringResult.newPos;
      inString = stringResult.inString;
      stringChar = stringResult.stringChar;

      // Only count parentheses and look for SELECT outside of strings
      if (!inString) {
        if (char === "(") {
          parenCount++;
        } else if (char === ")") {
          parenCount--;
        } else if (parenCount === 0) {
          // Check for nested WITH keyword at top level
          const remainingText = text.substring(pos);
          const nestedWithMatch = remainingText.match(/^\s*with\b/i);
          if (nestedWithMatch) {
            this.dbtTerminal.warn(
              "CteCodeLensProvider",
              `Found nested WITH clause at position ${pos}, bailing out - nested WITH clauses are not supported`,
            );
            return -1; // Signal failure due to nested WITH
          }

          // Check for SELECT keyword at top level
          const selectMatch = remainingText.match(/^\s*select\b/i);
          if (selectMatch) {
            selectsChecked++;
            this.dbtTerminal.debug(
              "CteCodeLensProvider",
              `Found top-level SELECT #${selectsChecked} at position ${pos}`,
            );
            return pos;
          }
        }
      }

      pos++;
    }

    this.dbtTerminal.warn(
      "CteCodeLensProvider",
      `No main SELECT found after WITH clause starting at ${withStartPos}, checked ${selectsChecked} SELECT statements`,
    );
    return text.length; // End of file if no main SELECT found
  }

  private extractCtesFromWithClause(
    withClauseContent: string,
    withStartPos: number,
    withClauseStart: number,
    document: TextDocument,
    ctes: CteInfo[],
  ): void {
    // Enhanced regex to handle quoted identifiers, dotted names, and complex column lists
    // Supports: identifier, "quoted identifier", schema.table, `backtick quoted`, [bracket quoted]
    const cteRegex =
      /((?:[a-zA-Z_][a-zA-Z0-9_]*|"[^"]+"|`[^`]+`|\[[^\]]+\])(?:\.(?:[a-zA-Z_][a-zA-Z0-9_]*|"[^"]+"|`[^`]+`|\[[^\]]+\]))*(?:\s*\([^)]*\))?)\s+as\s*\(/gi;
    let cteMatch;
    let cteIndex = 0;

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Extracting CTEs from WITH clause content starting at ${withStartPos}`,
    );

    while ((cteMatch = cteRegex.exec(withClauseContent)) !== null) {
      const cteName = cteMatch[1];
      const cteStartPos = withStartPos + cteMatch.index;
      const cteNameEndPos = withStartPos + cteMatch.index + cteMatch[1].length;

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Found CTE: ${cteName} at position ${cteStartPos}`,
      );

      // Find the opening parenthesis position
      const openParenPos =
        withStartPos + cteMatch.index + cteMatch[0].length - 1;

      // Find the matching closing parenthesis
      const cteQueryEnd = this.findMatchingClosingParen(
        withClauseContent,
        cteMatch.index + cteMatch[0].length - 1,
      );
      if (cteQueryEnd === -1) {
        this.dbtTerminal.warn(
          "CteCodeLensProvider",
          `Could not find matching closing parenthesis for CTE: ${cteName}`,
        );
        continue; // Skip if we can't find matching paren
      }

      // Adjust position back to full text
      const absoluteCteQueryEnd = withStartPos + cteQueryEnd;

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `CTE ${cteName} query range: ${openParenPos + 1} to ${absoluteCteQueryEnd}`,
      );

      // Create ranges
      const cteNameRange = new Range(
        document.positionAt(cteStartPos),
        document.positionAt(cteNameEndPos),
      );

      const cteQueryRange = new Range(
        document.positionAt(openParenPos + 1),
        document.positionAt(absoluteCteQueryEnd),
      );

      ctes.push({
        name: cteName,
        range: cteNameRange,
        queryRange: cteQueryRange,
        index: cteIndex,
        withClauseStart: withClauseStart,
      });

      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Successfully extracted CTE: ${cteName} (index: ${cteIndex})`,
      );

      cteIndex++;
    }

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Extracted ${cteIndex} CTEs from WITH clause`,
    );
  }

  private findMatchingClosingParen(text: string, openParenPos: number): number {
    let parenCount = 1;
    let pos = openParenPos + 1;
    let inString = false;
    let stringChar = "";
    let maxDepth = 0;

    this.dbtTerminal.debug(
      "CteCodeLensProvider",
      `Searching for matching closing paren starting at position ${openParenPos}`,
    );

    while (pos < text.length && parenCount > 0) {
      const char = text[pos];

      // Handle string literals using helper function
      const stringResult = this.handleSqlStringLiteral(
        text,
        pos,
        inString,
        stringChar,
      );
      pos = stringResult.newPos;
      inString = stringResult.inString;
      stringChar = stringResult.stringChar;

      // Only count parentheses outside of strings
      if (!inString) {
        if (char === "(") {
          parenCount++;
          maxDepth = Math.max(maxDepth, parenCount);
        } else if (char === ")") {
          parenCount--;
        }
      }

      pos++;
    }

    if (parenCount === 0) {
      this.dbtTerminal.debug(
        "CteCodeLensProvider",
        `Found matching closing paren at position ${pos - 1}, max depth: ${maxDepth}`,
      );
      return pos - 1;
    } else {
      this.dbtTerminal.warn(
        "CteCodeLensProvider",
        `Could not find matching closing paren, remaining open parens: ${parenCount}, max depth reached: ${maxDepth}`,
      );
      return -1;
    }
  }
}
