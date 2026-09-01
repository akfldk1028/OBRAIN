import Database from "better-sqlite3";
import type { ParsedNote } from "./note-parser.js";

export interface IndexedSearchHit {
  vaultId: string;
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  score: number;
}

interface SearchRow {
  vault_id: string;
  path: string;
  title: string;
  excerpt: string;
  tags_json: string;
  score: number;
}

export class SearchIndex {
  private readonly db: Database.Database;

  constructor(file: string) {
    this.db = new Database(file);
    try {
      this.db.pragma("foreign_keys = ON");
      this.db.pragma("journal_mode = WAL");
      this.db.pragma("busy_timeout = 5000");
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS notes (
          id INTEGER PRIMARY KEY,
          vault_id TEXT NOT NULL,
          path TEXT NOT NULL,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          excerpt TEXT NOT NULL,
          frontmatter_json TEXT NOT NULL,
          tags_json TEXT NOT NULL,
          mtime_ms REAL NOT NULL,
          size INTEGER NOT NULL,
          content_hash TEXT NOT NULL,
          UNIQUE(vault_id, path)
        );
        CREATE TABLE IF NOT EXISTS links (
          source_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
          target TEXT NOT NULL,
          UNIQUE(source_id, target)
        );
        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
          title,
          body,
          tags,
          content='notes',
          content_rowid='id',
          tokenize='trigram'
        );
        CREATE TRIGGER IF NOT EXISTS notes_ai AFTER INSERT ON notes BEGIN
          INSERT INTO notes_fts(rowid,title,body,tags)
          VALUES(new.id,new.title,new.body,new.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_ad AFTER DELETE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts,rowid,title,body,tags)
          VALUES('delete',old.id,old.title,old.body,old.tags_json);
        END;
        CREATE TRIGGER IF NOT EXISTS notes_au AFTER UPDATE ON notes BEGIN
          INSERT INTO notes_fts(notes_fts,rowid,title,body,tags)
          VALUES('delete',old.id,old.title,old.body,old.tags_json);
          INSERT INTO notes_fts(rowid,title,body,tags)
          VALUES(new.id,new.title,new.body,new.tags_json);
        END;
      `);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  upsert(note: ParsedNote): void {
    this.db.transaction(() => {
      const row = this.db.prepare(`
        INSERT INTO notes(
          vault_id,path,title,body,excerpt,frontmatter_json,tags_json,mtime_ms,size,content_hash
        ) VALUES(?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(vault_id,path) DO UPDATE SET
          title=excluded.title,
          body=excluded.body,
          excerpt=excluded.excerpt,
          frontmatter_json=excluded.frontmatter_json,
          tags_json=excluded.tags_json,
          mtime_ms=excluded.mtime_ms,
          size=excluded.size,
          content_hash=excluded.content_hash
        RETURNING id
      `).get(
        note.vaultId,
        note.path,
        note.title,
        note.body,
        note.excerpt,
        JSON.stringify(note.frontmatter),
        JSON.stringify(note.tags),
        note.mtimeMs,
        note.size,
        note.contentHash,
      ) as { id: number };

      this.db.prepare("DELETE FROM links WHERE source_id=?").run(row.id);
      const insertLink = this.db.prepare(
        "INSERT OR IGNORE INTO links(source_id,target) VALUES(?,?)",
      );
      for (const target of note.outgoingLinks) insertLink.run(row.id, target);
    })();
  }

  remove(vaultId: string, relativePath: string): void {
    this.db.prepare("DELETE FROM notes WHERE vault_id=? AND path=?")
      .run(vaultId, relativePath);
  }

  removeMissing(vaultId: string, presentPaths: Set<string>): void {
    const rows = this.db.prepare("SELECT path FROM notes WHERE vault_id=?")
      .all(vaultId) as Array<{ path: string }>;
    const remove = this.db.prepare("DELETE FROM notes WHERE vault_id=? AND path=?");
    this.db.transaction(() => {
      for (const row of rows) {
        if (!presentPaths.has(row.path)) remove.run(vaultId, row.path);
      }
    })();
  }

  search(query: string, allowedVaults: string[], limit: number): IndexedSearchHit[] {
    const trimmed = query.trim();
    if (!trimmed || allowedVaults.length === 0) return [];
    const boundedLimit = Math.max(1, Math.min(200, limit));
    const vaultSlots = allowedVaults.map(() => "?").join(",");
    let rows: SearchRow[];

    if ([...trimmed].length >= 3) {
      const phrase = `"${trimmed.replaceAll('"', '""')}"`;
      rows = this.db.prepare(`
        SELECT n.vault_id,n.path,n.title,n.excerpt,n.tags_json,
               -bm25(notes_fts) AS score
        FROM notes_fts
        JOIN notes n ON n.id=notes_fts.rowid
        WHERE notes_fts MATCH ? AND n.vault_id IN (${vaultSlots})
        ORDER BY score DESC,n.vault_id,n.path
        LIMIT ?
      `).all(phrase, ...allowedVaults, boundedLimit) as SearchRow[];
    } else {
      const escaped = trimmed.replace(/[\\%_]/g, "\\$&");
      const pattern = `%${escaped}%`;
      rows = this.db.prepare(`
        SELECT vault_id,path,title,excerpt,tags_json,0.0 AS score
        FROM notes
        WHERE vault_id IN (${vaultSlots})
          AND (
            title LIKE ? ESCAPE '\\'
            OR body LIKE ? ESCAPE '\\'
            OR tags_json LIKE ? ESCAPE '\\'
          )
        ORDER BY vault_id,path
        LIMIT ?
      `).all(...allowedVaults, pattern, pattern, pattern, boundedLimit) as SearchRow[];
    }

    return rows.map((row) => ({
      vaultId: row.vault_id,
      path: row.path,
      title: row.title,
      excerpt: row.excerpt,
      tags: JSON.parse(row.tags_json) as string[],
      score: row.score,
    }));
  }

  outgoingLinks(vaultId: string, relativePath: string): string[] {
    return (this.db.prepare(`
      SELECT l.target
      FROM links l JOIN notes n ON n.id=l.source_id
      WHERE n.vault_id=? AND n.path=?
      ORDER BY l.target
    `).all(vaultId, relativePath) as Array<{ target: string }>).map((row) => row.target);
  }

  backlinks(vaultId: string, relativePath: string): string[] {
    const normalize = (value: string) => value
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/\.md$/i, "")
      .toLowerCase();
    const wanted = normalize(relativePath);
    const basename = wanted.split("/").at(-1);
    const rows = this.db.prepare(`
      SELECT n.path,l.target
      FROM links l JOIN notes n ON n.id=l.source_id
      WHERE n.vault_id=?
      ORDER BY n.path
    `).all(vaultId) as Array<{ path: string; target: string }>;

    return [...new Set(rows.filter((row) => {
      const target = normalize(row.target);
      return target === wanted || (!target.includes("/") && target === basename);
    }).map((row) => row.path))];
  }

  clear(): void {
    this.db.exec("DELETE FROM links; DELETE FROM notes;");
  }

  close(): void {
    this.db.close();
  }
}
