(function () {
  "use strict";

  /* ============ State ============ */
  let vault = {
    folders: { root: { id: "root", name: "Vault", parentId: null } },
    notes: {},
  };
  let activeNoteId = null;
  let currentNote = null;
  let expandedFolders = new Set(["root"]);
  let saveTimer = null;

  /* ============ Helpers ============ */
  function uid() {
    return crypto.randomUUID
      ? crypto.randomUUID()
      : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function slugify(s) {
    return String(s)
      .toLowerCase()
      .trim()
      .replace(/\.md$/i, "")
      .replace(/^\.?\/?/, "")
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }
  function slugifyPath(path) {
    return String(path)
      .split("/")
      .map(function (segment) {
        return slugify(segment);
      })
      .filter(Boolean)
      .join("/");
  }
  function getNotePath(note) {
    return getFolderPath(note.folderId)
      .concat([note.name])
      .map(function (segment) {
        return slugify(segment);
      })
      .join("/");
  }
  function findNoteByLinkTarget(target) {
    const normalized = slugifyPath(target);
    if (!normalized) return null;
    const notes = Object.values(vault.notes);
    const byPath = notes.find(function (n) {
      return getNotePath(n) === normalized;
    });
    if (byPath) return byPath;
    if (normalized.indexOf("/") === -1) {
      return notes.find(function (n) {
        return slugify(n.name) === normalized;
      });
    }
    return null;
  }
  function downloadBlob(content, filename, type) {
    const blob = new Blob([content], { type: type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }
  function getFolderPath(folderId) {
    const path = [];
    const visited = new Set();
    let f = vault.folders[folderId];
    while (f && f.id !== "root" && !visited.has(f.id)) {
      visited.add(f.id);
      path.unshift(f.name);
      f = vault.folders[f.parentId];
    }
    return path;
  }

  const DB_NAME = "markdownicide";
  const DB_STORE = "vault";
  const DB_KEY = "vault";
  const idbSupported = !!window.indexedDB;

  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!idbSupported) return reject(new Error("IndexedDB not supported"));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function (event) {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(DB_STORE)) {
          db.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = function (event) {
        resolve(event.target.result);
      };
      request.onerror = function (event) {
        reject(event.target.error || new Error("IndexedDB open failed"));
      };
    });
  }

  function idbTransaction(mode, callback) {
    return openDB().then(function (db) {
      return new Promise(function (resolve, reject) {
        const tx = db.transaction(DB_STORE, mode);
        const store = tx.objectStore(DB_STORE);
        let request;
        try {
          request = callback(store);
        } catch (err) {
          reject(err);
        }
        tx.oncomplete = function () {
          resolve(request && request.result);
        };
        tx.onabort = tx.onerror = function () {
          reject(
            tx.error ||
              (request && request.error) ||
              new Error("IndexedDB transaction failed"),
          );
        };
      });
    });
  }

  function idbGet(key) {
    return idbTransaction("readonly", function (store) {
      return store.get(key);
    });
  }

  function idbPut(key, value) {
    return idbTransaction("readwrite", function (store) {
      return store.put(value, key);
    });
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      if (!idbSupported) return;
      idbPut(DB_KEY, JSON.stringify(vault)).catch(function (e) {
        console.error("save failed", e);
      });
    }, 350);
  }

  /* ============ Seed data ============ */
  function seedVault() {
    const folderId = uid();
    vault.folders[folderId] = {
      id: folderId,
      name: "Getting Started",
      parentId: "root",
    };
    const entryId = uid(),
      secondId = uid(),
      thirdId = uid();
    vault.notes[entryId] = {
      id: entryId,
      name: "Entry",
      folderId: folderId,
      content: `# Welcome to Markdownicide

This is your vault's entry note. Markdownicide renders **Markdown** styling live, right in the text — there is no separate preview pane.

Try it out:
- *Italic*, **bold**, \`inline code\`, and ~~strikethrough~~ all work inline.
- Link to another note like [Second Note](./second-note) to connect your knowledge graph.
- Ctrl+Click a link to follow it.

> Every note is a node. Every link is an edge.

## Next steps
1. Create a folder from the Files panel.
2. Add a note and start writing.
3. Close this note to see the vault graph.`,
    };
    vault.notes[secondId] = {
      id: secondId,
      name: "Second Note",
      folderId: folderId,
      content: `# Second Note

This note links back to the [Entry](./entry) note, and onward to a [Third Note](./third-note).

\`\`\`
a code block looks like this
\`\`\``,
    };
    vault.notes[thirdId] = {
      id: thirdId,
      name: "Third Note",
      folderId: folderId,
      content: `# Third Note

This one links straight back to [Entry](./entry) too, closing the loop in the graph view.`,
    };
  }

  /* ============ Inline / block markdown rendering (live editor, marks visible) ============ */
  /* Single-pass tokenizer: we scan the raw line once and only ever escape/emit plain
     source text into the HTML we build. Earlier versions ran one regex.replace() after
     another on the *already-tagged* HTML string, so a later pass (e.g. italic) could
     match stray "*" characters sitting inside a mark <span> emitted by an earlier pass
     (e.g. bold) - that's what caused the trailing "*" to render white/italic. Scanning
     the raw text once, left to right, means each character is only ever considered once. */
  const INLINE_TOKEN_RE =
    /(`+)([^`]+?)\1|(\*\*|__)([^\s](?:[^*_]*?[^\s])?)\3|(\*|_)([^\s](?:[^*_]*?[^\s])?)\5|(~~)([^~]+?)~~|\[([^\]]+)\]\(([^)]+)\)/g;
  function inlineFormat(raw) {
    let out = "";
    let lastIndex = 0;
    let m;
    INLINE_TOKEN_RE.lastIndex = 0;
    while ((m = INLINE_TOKEN_RE.exec(raw))) {
      out += escapeHtml(raw.slice(lastIndex, m.index));
      if (m[1] !== undefined) {
        out +=
          '<span class="md-mark">' +
          m[1] +
          '</span><span class="md-code">' +
          escapeHtml(m[2]) +
          '</span><span class="md-mark">' +
          m[1] +
          "</span>";
      } else if (m[3] !== undefined) {
        out +=
          '<span class="md-mark">' +
          m[3] +
          "</span><strong>" +
          escapeHtml(m[4]) +
          '</strong><span class="md-mark">' +
          m[3] +
          "</span>";
      } else if (m[5] !== undefined) {
        out +=
          '<span class="md-mark">' +
          m[5] +
          "</span><em>" +
          escapeHtml(m[6]) +
          '</em><span class="md-mark">' +
          m[5] +
          "</span>";
      } else if (m[7] !== undefined) {
        out +=
          '<span class="md-mark">~~</span><del>' +
          escapeHtml(m[8]) +
          '</del><span class="md-mark">~~</span>';
      } else if (m[9] !== undefined) {
        const url = m[10];
        out +=
          '<span class="md-mark">[</span><a class="md-link" href="#" data-href="' +
          escapeHtml(url).replace(/"/g, "&quot;") +
          '">' +
          escapeHtml(m[9]) +
          '</a><span class="md-mark">](' +
          escapeHtml(url) +
          ")</span>";
      }
      lastIndex = INLINE_TOKEN_RE.lastIndex;
    }
    out += escapeHtml(raw.slice(lastIndex));
    return out;
  }
  function renderLineHTML(raw) {
    if (raw === "") return "<br>";
    let m = raw.match(/^(#{1,6})\s+(.*)$/);
    if (m) {
      const level = m[1].length;
      return (
        '<span class="md-mark">' +
        m[1] +
        ' </span><span class="md-h md-h' +
        level +
        '">' +
        inlineFormat(m[2]) +
        "</span>"
      );
    }
    m = raw.match(/^(>\s?)(.*)$/);
    if (m) {
      return (
        '<span class="md-mark">' +
        m[1] +
        '</span><span class="md-quote">' +
        inlineFormat(m[2]) +
        "</span>"
      );
    }
    m = raw.match(/^(\s*[-*+]\s)(.*)$/);
    if (m) {
      return (
        '<span class="md-mark md-bullet">' +
        m[1] +
        "</span>" +
        inlineFormat(m[2])
      );
    }
    m = raw.match(/^(\s*\d+\.\s)(.*)$/);
    if (m) {
      return (
        '<span class="md-mark md-bullet">' +
        m[1] +
        "</span>" +
        inlineFormat(m[2])
      );
    }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) {
      return '<span class="md-mark md-hr">' + escapeHtml(raw) + "</span>";
    }
    return inlineFormat(raw);
  }
  function renderEditorContentHTML(rawLines) {
    let inFence = false;
    let html = "";
    for (let i = 0; i < rawLines.length; i++) {
      const raw = rawLines[i];
      if (/^```/.test(raw)) {
        inFence = !inFence;
        html +=
          '<div class="md-line md-codeblock"><span class="md-mark">' +
          escapeHtml(raw) +
          "</span></div>";
        continue;
      }
      if (inFence) {
        html +=
          '<div class="md-line md-codeblock">' +
          (escapeHtml(raw) || "<br>") +
          "</div>";
        continue;
      }
      html += '<div class="md-line">' + renderLineHTML(raw) + "</div>";
    }
    return html;
  }
  function renderEditorContent(rawLines) {
    editorEl.innerHTML = renderEditorContentHTML(rawLines);
  }

  /* ============ Export-time markdown -> clean HTML ============ */
  function inlineFormatExport(raw) {
    let out = "";
    let lastIndex = 0;
    let m;
    INLINE_TOKEN_RE.lastIndex = 0;
    while ((m = INLINE_TOKEN_RE.exec(raw))) {
      out += escapeHtml(raw.slice(lastIndex, m.index));
      if (m[1] !== undefined) out += "<code>" + escapeHtml(m[2]) + "</code>";
      else if (m[3] !== undefined)
        out += "<strong>" + escapeHtml(m[4]) + "</strong>";
      else if (m[5] !== undefined) out += "<em>" + escapeHtml(m[6]) + "</em>";
      else if (m[7] !== undefined) out += "<del>" + escapeHtml(m[8]) + "</del>";
      else if (m[9] !== undefined) {
        const cleanUrl = m[10].replace(/^[\s\x00-\x1F]+/g, "");
        const safeUrl = /^(https?:|\/\/)/i.test(cleanUrl) ? cleanUrl : "#";
        out +=
          '<a href="' +
          escapeHtml(safeUrl).replace(/"/g, "&quot;") +
          '">' +
          escapeHtml(m[9]) +
          "</a>";
      }
      lastIndex = INLINE_TOKEN_RE.lastIndex;
    }
    out += escapeHtml(raw.slice(lastIndex));
    let text = out;
    return text;
  }
  function markdownToHTMLBlocks(content) {
    const lines = content.split("\n");
    let html = "";
    let inFence = false,
      fenceBuf = [];
    let listBuf = [],
      listType = null;
    function flushList() {
      if (listBuf.length) {
        const tag = listType === "ol" ? "ol" : "ul";
        html +=
          "<" +
          tag +
          ">" +
          listBuf
            .map(function (i) {
              return "<li>" + inlineFormatExport(i) + "</li>";
            })
            .join("") +
          "</" +
          tag +
          ">";
        listBuf = [];
        listType = null;
      }
    }
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (/^```/.test(raw)) {
        if (!inFence) {
          inFence = true;
          fenceBuf = [];
        } else {
          inFence = false;
          html +=
            "<pre><code>" + escapeHtml(fenceBuf.join("\n")) + "</code></pre>";
        }
        continue;
      }
      if (inFence) {
        fenceBuf.push(raw);
        continue;
      }
      let m = raw.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flushList();
        html +=
          "<h" +
          m[1].length +
          ">" +
          inlineFormatExport(m[2]) +
          "</h" +
          m[1].length +
          ">";
        continue;
      }
      m = raw.match(/^>\s?(.*)$/);
      if (m) {
        flushList();
        html += "<blockquote>" + inlineFormatExport(m[1]) + "</blockquote>";
        continue;
      }
      m = raw.match(/^\s*[-*+]\s+(.*)$/);
      if (m) {
        if (listType !== "ul") {
          flushList();
          listType = "ul";
        }
        listBuf.push(m[1]);
        continue;
      }
      m = raw.match(/^\s*\d+\.\s+(.*)$/);
      if (m) {
        if (listType !== "ol") {
          flushList();
          listType = "ol";
        }
        listBuf.push(m[1]);
        continue;
      }
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(raw)) {
        flushList();
        html += "<hr>";
        continue;
      }
      flushList();
      if (raw.trim() !== "") html += "<p>" + inlineFormatExport(raw) + "</p>";
    }
    flushList();
    if (inFence && fenceBuf.length)
      html += "<pre><code>" + escapeHtml(fenceBuf.join("\n")) + "</code></pre>";
    return html;
  }
  const EXPORT_STYLE =
    "body{font-family:'Roboto',sans-serif;max-width:760px;margin:40px auto;padding:0 20px;background:#fff;color:#111;line-height:1.65;}" +
    "h1,h2,h3,h4,h5,h6{font-weight:700;margin-top:1.4em;}" +
    "code,pre{font-family:'Roboto Mono',monospace;}" +
    "pre{background:#f4f4f4;padding:12px;overflow:auto;}" +
    "code{background:#f0f0f0;padding:2px 4px;}" +
    "blockquote{border-left:3px solid #999;margin:0;padding-left:16px;color:#555;font-style:italic;}" +
    "a{color:#111;}";

  function exportMD(note) {
    downloadBlob(note.content, note.name + ".md", "text/markdown");
  }
  function exportHTML(note) {
    const body = markdownToHTMLBlocks(note.content);
    const doc =
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
      escapeHtml(note.name) +
      "</title><style>" +
      EXPORT_STYLE +
      "</style></head><body>" +
      body +
      "</body></html>";
    downloadBlob(doc, note.name + ".html", "text/html");
  }
  function exportPDF(note) {
    const body = markdownToHTMLBlocks(note.content);
    const w = window.open("", "_blank");
    if (!w) {
      alert("Please allow pop-ups to export as PDF.");
      return;
    }
    w.document.write(
      '<!DOCTYPE html><html><head><meta charset="utf-8"><title>' +
        escapeHtml(note.name) +
        "</title><style>" +
        EXPORT_STYLE +
        "</style></head><body>" +
        body +
        "</body></html>",
    );
    w.document.close();
    w.focus();
    setTimeout(function () {
      w.print();
    }, 300);
  }

  /* ============ Vault-level actions ============ */
  function exportVaultJSON() {
    downloadBlob(
      JSON.stringify(vault, null, 2),
      "markdownicide-vault.json",
      "application/json",
    );
  }
  function importVaultJSON(file) {
    const reader = new FileReader();
    reader.onload = function () {
      try {
        const data = JSON.parse(reader.result);
        if (data && data.folders && data.notes) {
          vault = data;
          if (!vault.folders.root)
            vault.folders.root = {
              id: "root",
              name: "Vault",
              parentId: null,
            };
          activeNoteId = null;
          currentNote = null;
          expandedFolders = new Set(["root"]);
          scheduleSave();
          renderAll();
        } else {
          alert("That file does not look like a Markdownicide vault export.");
        }
      } catch (e) {
        alert("Could not parse that file as vault JSON.");
      }
    };
    reader.readAsText(file);
  }
  function clearVault() {
    if (
      !confirm(
        "Clear the entire vault? This permanently deletes every folder and note.",
      )
    )
      return;
    vault = {
      folders: { root: { id: "root", name: "Vault", parentId: null } },
      notes: {},
    };
    activeNoteId = null;
    currentNote = null;
    expandedFolders = new Set(["root"]);
    scheduleSave();
    renderAll();
  }
  function exportAllZip() {
    if (typeof JSZip === "undefined") {
      alert("Zip export is unavailable right now.");
      return;
    }
    const zip = new JSZip();
    Object.values(vault.notes).forEach(function (n) {
      const folderPath = getFolderPath(n.folderId);
      const path =
        (folderPath.length ? folderPath.join("/") + "/" : "") + n.name + ".md";
      zip.file(path, n.content);
    });
    zip.generateAsync({ type: "blob" }).then(function (blob) {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "markdownicide-notes.zip";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    });
  }

  /* ============ Folder / note CRUD ============ */
  function createFolder(parentId) {
    const name = prompt("Folder name:", "New Folder");
    if (!name) return;
    const id = uid();
    vault.folders[id] = { id: id, name: name, parentId: parentId };
    expandedFolders.add(parentId);
    scheduleSave();
    renderFileTree();
    updateStats();
  }
  function createNote(folderId) {
    const name = prompt("Note name:", "Untitled");
    if (!name) return;
    const id = uid();
    vault.notes[id] = {
      id: id,
      name: name,
      folderId: folderId,
      content: "# " + name + "\n\n",
    };
    expandedFolders.add(folderId);
    scheduleSave();
    renderFileTree();
    updateStats();
    openNote(id);
  }
  function renameFolder(id) {
    const f = vault.folders[id];
    const name = prompt("Rename folder:", f.name);
    if (!name) return;
    f.name = name;
    scheduleSave();
    renderFileTree();
    if (currentNote) renderEditorHeader();
  }
  function renameNote(id) {
    const n = vault.notes[id];
    const name = prompt("Rename note:", n.name);
    if (!name) return;
    n.name = name;
    scheduleSave();
    renderFileTree();
    if (activeNoteId === id) renderEditorHeader();
  }
  function deleteFolder(id) {
    if (id === "root") return;
    if (!confirm("Delete this folder and everything inside it?")) return;
    const toDelete = [id];
    for (let i = 0; i < toDelete.length; i++) {
      const fid = toDelete[i];
      Object.values(vault.folders).forEach(function (f) {
        if (f.parentId === fid) toDelete.push(f.id);
      });
    }
    Object.values(vault.notes).forEach(function (n) {
      if (toDelete.indexOf(n.folderId) !== -1) {
        delete vault.notes[n.id];
        if (activeNoteId === n.id) {
          activeNoteId = null;
          currentNote = null;
        }
      }
    });
    toDelete.forEach(function (fid) {
      delete vault.folders[fid];
    });
    scheduleSave();
    renderAll();
  }
  function deleteNote(id) {
    if (!confirm("Delete this note?")) return;
    delete vault.notes[id];
    if (activeNoteId === id) {
      activeNoteId = null;
      currentNote = null;
    }
    scheduleSave();
    renderAll();
  }
  function toggleFolder(id) {
    if (expandedFolders.has(id)) expandedFolders.delete(id);
    else expandedFolders.add(id);
    renderFileTree();
  }

  /* ============ File tree rendering ============ */
  function renderFileTree() {
    filesTreeEl.innerHTML = "";
    filesTreeEl.appendChild(renderFolderNode("root", 0));
  }
  function renderFolderNode(folderId, depth) {
    const folder = vault.folders[folderId];
    const wrapper = document.createElement("div");
    const row = document.createElement("div");
    row.className = "tree-row folder-row";
    row.style.paddingLeft = depth * 16 + 6 + "px";
    const expanded = expandedFolders.has(folderId);
    row.innerHTML =
      '<span class="material-symbols-sharp chevron">' +
      (expanded ? "expand_more" : "chevron_right") +
      "</span>" +
      '<span class="material-symbols-sharp folder-icon">' +
      (expanded ? "folder_open" : "folder") +
      "</span>" +
      '<span class="tree-label">' +
      escapeHtml(folder.name) +
      "</span>" +
      '<span class="tree-actions">' +
      '<span class="material-symbols-sharp tact" data-act="newnote" title="New note">note_add</span>' +
      '<span class="material-symbols-sharp tact" data-act="newfolder" title="New folder">create_new_folder</span>' +
      (folderId !== "root"
        ? '<span class="material-symbols-sharp tact" data-act="rename" title="Rename">edit</span><span class="material-symbols-sharp tact" data-act="delete" title="Delete">delete</span>'
        : "") +
      "</span>";
    row.addEventListener("click", function (e) {
      if (e.target && e.target.dataset && e.target.dataset.act) return;
      toggleFolder(folderId);
    });
    row.querySelectorAll(".tact").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "newnote") createNote(folderId);
        else if (act === "newfolder") createFolder(folderId);
        else if (act === "rename") renameFolder(folderId);
        else if (act === "delete") deleteFolder(folderId);
      });
    });
    wrapper.appendChild(row);
    if (expanded) {
      const childFolders = Object.values(vault.folders)
        .filter(function (f) {
          return f.parentId === folderId;
        })
        .sort(function (a, b) {
          return a.name.localeCompare(b.name);
        });
      const childNotes = Object.values(vault.notes)
        .filter(function (n) {
          return n.folderId === folderId;
        })
        .sort(function (a, b) {
          return a.name.localeCompare(b.name);
        });
      childFolders.forEach(function (f) {
        wrapper.appendChild(renderFolderNode(f.id, depth + 1));
      });
      childNotes.forEach(function (n) {
        wrapper.appendChild(renderNoteRow(n, depth + 1));
      });
    }
    return wrapper;
  }
  function renderNoteRow(note, depth) {
    const row = document.createElement("div");
    row.className =
      "tree-row note-row" + (activeNoteId === note.id ? " active" : "");
    row.style.paddingLeft = depth * 16 + 6 + "px";
    row.dataset.noteId = note.id;
    row.innerHTML =
      '<span class="chevron-spacer"></span>' +
      '<span class="material-symbols-sharp note-icon">description</span>' +
      '<span class="tree-label">' +
      escapeHtml(note.name) +
      "</span>" +
      '<span class="tree-actions">' +
      '<span class="material-symbols-sharp tact" data-act="rename" title="Rename">edit</span>' +
      '<span class="material-symbols-sharp tact" data-act="delete" title="Delete">delete</span>' +
      "</span>";
    row.addEventListener("click", function (e) {
      if (e.target && e.target.dataset && e.target.dataset.act) return;
      openNote(note.id);
    });
    row.querySelectorAll(".tact").forEach(function (btn) {
      btn.addEventListener("click", function (e) {
        e.stopPropagation();
        const act = btn.dataset.act;
        if (act === "rename") renameNote(note.id);
        else if (act === "delete") deleteNote(note.id);
      });
    });
    return row;
  }
  function highlightActiveInTree() {
    document.querySelectorAll(".note-row").forEach(function (r) {
      r.classList.toggle("active", r.dataset.noteId === activeNoteId);
    });
  }

  /* ============ Search ============ */
  function runSearch(q) {
    q = q.trim().toLowerCase();
    if (!q) {
      searchResultsEl.innerHTML =
        '<div class="empty-hint">Type to search across every note\'s title and contents.</div>';
      return;
    }
    const matches = Object.values(vault.notes).filter(function (n) {
      return (
        n.name.toLowerCase().indexOf(q) !== -1 ||
        n.content.toLowerCase().indexOf(q) !== -1
      );
    });
    if (matches.length === 0) {
      searchResultsEl.innerHTML =
        '<div class="empty-hint">No matches found.</div>';
      return;
    }
    searchResultsEl.innerHTML = "";
    matches.forEach(function (n) {
      const lower = n.content.toLowerCase();
      const idx = lower.indexOf(q);
      let snippet = "";
      if (idx !== -1) {
        const start = Math.max(0, idx - 30);
        snippet =
          (start > 0 ? "…" : "") +
          n.content.substring(start, idx + q.length + 30) +
          "…";
      }
      const div = document.createElement("div");
      div.className = "search-result";
      div.innerHTML =
        '<div class="sr-name"><span class="material-symbols-sharp">description</span>' +
        escapeHtml(n.name) +
        "</div>" +
        '<div class="sr-path">' +
        escapeHtml(getFolderPath(n.folderId).join(" / ") || "Vault") +
        "</div>" +
        (snippet
          ? '<div class="sr-snippet">' + escapeHtml(snippet) + "</div>"
          : "");
      div.addEventListener("click", function () {
        switchRail("files");
        openNote(n.id);
      });
      searchResultsEl.appendChild(div);
    });
  }

  /* ============ Caret helpers ============ */
  function getCaretPosition() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return { line: 0, col: 0 };
    const range = sel.getRangeAt(0);
    let lineDiv =
      range.startContainer.nodeType === 3
        ? range.startContainer.parentElement
        : range.startContainer;
    while (
      lineDiv &&
      lineDiv !== editorEl &&
      !lineDiv.classList.contains("md-line")
    )
      lineDiv = lineDiv.parentElement;
    if (!lineDiv || lineDiv === editorEl) return { line: 0, col: 0 };
    const lines = Array.prototype.slice.call(
      editorEl.querySelectorAll(".md-line"),
    );
    const lineIndex = lines.indexOf(lineDiv);
    const preRange = range.cloneRange();
    preRange.selectNodeContents(lineDiv);
    preRange.setEnd(range.startContainer, range.startOffset);
    const col = preRange.toString().length;
    return { line: lineIndex < 0 ? 0 : lineIndex, col: col };
  }
  function setCaretPosition(line, col) {
    const lines = Array.prototype.slice.call(
      editorEl.querySelectorAll(".md-line"),
    );
    const lineDiv = lines[line] || lines[lines.length - 1];
    if (!lineDiv) return;
    const sel = window.getSelection();
    const range = document.createRange();
    let charCount = 0,
      found = false;
    (function traverse(node) {
      if (found) return;
      if (node.nodeType === 3) {
        const next = charCount + node.length;
        if (col <= next) {
          range.setStart(node, col - charCount);
          found = true;
          return;
        }
        charCount = next;
      } else if (node.nodeType === 1 && node.tagName !== "BR") {
        for (let i = 0; i < node.childNodes.length; i++) {
          traverse(node.childNodes[i]);
          if (found) return;
        }
      }
    })(lineDiv);
    if (!found) {
      range.selectNodeContents(lineDiv);
      range.collapse(false);
    } else range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  /* ============ Editor events ============ */
  function onEditorInput() {
    if (!currentNote) return;
    const pos = getCaretPosition();
    const lines = Array.prototype.slice
      .call(editorEl.querySelectorAll(".md-line"))
      .map(function (d) {
        return d.innerText.replace(/\n/g, "");
      });
    currentNote.content = lines.join("\n");
    renderEditorContent(lines);
    setCaretPosition(pos.line, pos.col);
    scheduleSave();
  }
  function onEditorKeydown(e) {
    if (!currentNote) return;
    if (e.key === "Enter") {
      e.preventDefault();
      const pos = getCaretPosition();
      const rawLines = currentNote.content.split("\n");
      const line = rawLines[pos.line] || "";
      const before = line.slice(0, pos.col);
      const after = line.slice(pos.col);
      rawLines.splice(pos.line, 1, before, after);
      currentNote.content = rawLines.join("\n");
      renderEditorContent(rawLines);
      setCaretPosition(pos.line + 1, 0);
      scheduleSave();
    } else if (e.key === "Backspace") {
      const pos = getCaretPosition();
      if (pos.col === 0 && pos.line > 0) {
        e.preventDefault();
        const rawLines = currentNote.content.split("\n");
        const prevLen = rawLines[pos.line - 1].length;
        rawLines[pos.line - 1] = rawLines[pos.line - 1] + rawLines[pos.line];
        rawLines.splice(pos.line, 1);
        currentNote.content = rawLines.join("\n");
        renderEditorContent(rawLines);
        setCaretPosition(pos.line - 1, prevLen);
        scheduleSave();
      }
    } else if (e.key === "Tab") {
      e.preventDefault();
      const pos = getCaretPosition();
      const rawLines = currentNote.content.split("\n");
      const line = rawLines[pos.line] || "";
      rawLines[pos.line] = line.slice(0, pos.col) + "  " + line.slice(pos.col);
      currentNote.content = rawLines.join("\n");
      renderEditorContent(rawLines);
      setCaretPosition(pos.line, pos.col + 2);
      scheduleSave();
    }
  }
  function onEditorPaste(e) {
    if (!currentNote) return;
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData(
      "text/plain",
    );
    const pos = getCaretPosition();
    const rawLines = currentNote.content.split("\n");
    const line = rawLines[pos.line] || "";
    const before = line.slice(0, pos.col);
    const after = line.slice(pos.col);
    const pasted = text.split("\n");
    const newLines = [before + pasted[0]];
    for (let i = 1; i < pasted.length; i++) newLines.push(pasted[i]);
    newLines[newLines.length - 1] += after;
    rawLines.splice(pos.line, 1, ...newLines);
    currentNote.content = rawLines.join("\n");
    renderEditorContent(rawLines);
    const newLine = pos.line + pasted.length - 1;
    const newCol =
      pasted.length === 1
        ? pos.col + text.length
        : pasted[pasted.length - 1].length;
    setCaretPosition(newLine, newCol);
    scheduleSave();
  }
  function onEditorClick(e) {
    const a = e.target.closest && e.target.closest("a.md-link");
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const found = findNoteByLinkTarget(a.dataset.href);
      if (found) openNote(found.id);
    } else if (a) {
      e.preventDefault();
    }
  }

  /* ============ Note open / close, editor header ============ */
  function renderEditorHeader() {
    if (!currentNote) return;
    const path = getFolderPath(currentNote.folderId).concat([currentNote.name]);
    breadcrumbEl.textContent = path.join(" / ");
  }
  function openNote(id) {
    const note = vault.notes[id];
    if (!note) return;
    activeNoteId = id;
    currentNote = note;
    editorWrapEl.style.display = "flex";
    graphWrapEl.style.display = "none";
    renderEditorContent(note.content.split("\n"));
    renderEditorHeader();
    highlightActiveInTree();
  }
  function closeNote() {
    activeNoteId = null;
    currentNote = null;
    editorWrapEl.style.display = "none";
    graphWrapEl.style.display = "flex";
    highlightActiveInTree();
    renderGraph();
  }

  /* ============ Node graph ============ */
  function buildGraphData() {
    const notes = Object.values(vault.notes);
    const nodes = notes.map(function (n) {
      return { id: n.id, name: n.name };
    });
    const links = [];
    const linkRe = /\[([^\]]+)\]\(([^)]+)\)/g;
    notes.forEach(function (n) {
      let m;
      linkRe.lastIndex = 0;
      while ((m = linkRe.exec(n.content))) {
        const target = m[2];
        const found = findNoteByLinkTarget(target);
        if (found && found.id !== n.id) {
          links.push({ source: n.id, target: found.id });
        }
      }
    });
    return { nodes: nodes, links: links };
  }
  function renderGraph() {
    if (typeof d3 === "undefined") return;
    const data = buildGraphData();
    const svg = d3.select("#graph");
    svg.selectAll("*").remove();
    const width = graphSvgEl.clientWidth || 800;
    const height = graphSvgEl.clientHeight || 600;
    svg.attr("viewBox", [0, 0, width, height]);
    if (data.nodes.length === 0) {
      svg
        .append("text")
        .attr("x", width / 2)
        .attr("y", height / 2)
        .attr("text-anchor", "middle")
        .attr("fill", "#777")
        .style("font-family", "Roboto")
        .style("font-size", "13px")
        .text("No notes yet — create one from the Files panel to get started.");
      return;
    }
    const sim = d3
      .forceSimulation(data.nodes)
      .force(
        "link",
        d3
          .forceLink(data.links)
          .id(function (d) {
            return d.id;
          })
          .distance(130),
      )
      .force("charge", d3.forceManyBody().strength(-260))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collide", d3.forceCollide(48));
    const link = svg
      .append("g")
      .selectAll("line")
      .data(data.links)
      .join("line")
      .attr("stroke", "#5a5a5a")
      .attr("stroke-width", 1.5);
    const node = svg
      .append("g")
      .selectAll("g")
      .data(data.nodes)
      .join("g")
      .attr("class", "graph-node")
      .call(
        d3
          .drag()
          .on("start", function (event, d) {
            if (!event.active) sim.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
          })
          .on("drag", function (event, d) {
            d.fx = event.x;
            d.fy = event.y;
          })
          .on("end", function (event, d) {
            if (!event.active) sim.alphaTarget(0);
            d.fx = null;
            d.fy = null;
          }),
      )
      .on("click", function (event, d) {
        openNote(d.id);
        switchRail("files");
      });
    node
      .append("rect")
      .attr("width", 14)
      .attr("height", 14)
      .attr("x", -7)
      .attr("y", -7);
    node
      .append("text")
      .text(function (d) {
        return d.name;
      })
      .attr("x", 12)
      .attr("y", 4);
    sim.on("tick", function () {
      link
        .attr("x1", function (d) {
          return d.source.x;
        })
        .attr("y1", function (d) {
          return d.source.y;
        })
        .attr("x2", function (d) {
          return d.target.x;
        })
        .attr("y2", function (d) {
          return d.target.y;
        });
      node.attr("transform", function (d) {
        return "translate(" + d.x + "," + d.y + ")";
      });
    });
  }

  /* ============ Rail switching ============ */
  function switchRail(view) {
    document.querySelectorAll(".rail-btn").forEach(function (b) {
      b.classList.toggle("active", b.dataset.view === view);
    });
    document.querySelectorAll(".sb-view").forEach(function (v) {
      v.classList.toggle("active", v.id === "view-" + view);
    });
  }

  /* ============ Stats + full render ============ */
  function updateStats() {
    statNotesEl.textContent = Object.keys(vault.notes).length;
    statFoldersEl.textContent = Object.keys(vault.folders).length - 1;
  }
  function renderAll() {
    renderFileTree();
    updateStats();
    if (activeNoteId && vault.notes[activeNoteId]) {
      openNote(activeNoteId);
    } else {
      closeNote();
    }
  }

  /* ============ DOM refs (assigned on init) ============ */
  let filesTreeEl,
    searchResultsEl,
    editorEl,
    editorWrapEl,
    graphWrapEl,
    graphSvgEl,
    breadcrumbEl,
    statNotesEl,
    statFoldersEl;

  function wireUp() {
    filesTreeEl = document.getElementById("files-tree");
    searchResultsEl = document.getElementById("search-results");
    editorEl = document.getElementById("editor");
    editorWrapEl = document.getElementById("editor-wrap");
    graphWrapEl = document.getElementById("graph-wrap");
    graphSvgEl = document.getElementById("graph");
    breadcrumbEl = document.getElementById("breadcrumb");
    statNotesEl = document.getElementById("stat-notes");
    statFoldersEl = document.getElementById("stat-folders");

    document.querySelectorAll(".rail-btn").forEach(function (b) {
      b.addEventListener("click", function () {
        switchRail(b.dataset.view);
      });
    });

    document
      .getElementById("btn-new-note-root")
      .addEventListener("click", function () {
        createNote("root");
      });
    document
      .getElementById("btn-new-folder-root")
      .addEventListener("click", function () {
        createFolder("root");
      });

    document
      .getElementById("search-input")
      .addEventListener("input", function (e) {
        runSearch(e.target.value);
      });

    document
      .getElementById("btn-export-json")
      .addEventListener("click", exportVaultJSON);
    document
      .getElementById("btn-export-zip")
      .addEventListener("click", exportAllZip);
    document
      .getElementById("btn-clear-vault")
      .addEventListener("click", clearVault);
    document
      .getElementById("import-input")
      .addEventListener("change", function (e) {
        if (e.target.files && e.target.files[0])
          importVaultJSON(e.target.files[0]);
        e.target.value = "";
      });

    document.getElementById("exp-md").addEventListener("click", function () {
      if (currentNote) exportMD(currentNote);
    });
    document.getElementById("exp-html").addEventListener("click", function () {
      if (currentNote) exportHTML(currentNote);
    });
    document.getElementById("exp-pdf").addEventListener("click", function () {
      if (currentNote) exportPDF(currentNote);
    });
    document
      .getElementById("btn-close-note")
      .addEventListener("click", closeNote);

    editorEl.addEventListener("input", onEditorInput);
    editorEl.addEventListener("keydown", onEditorKeydown);
    editorEl.addEventListener("paste", onEditorPaste);
    editorEl.addEventListener("click", onEditorClick);

    window.addEventListener("resize", function () {
      if (!currentNote) renderGraph();
    });
  }

  /* ============ Init ============ */
  async function init() {
    wireUp();
    if (!idbSupported) {
      seedVault();
      renderAll();
      return;
    }

    try {
      const result = await idbGet(DB_KEY);
      if (result) {
        vault = JSON.parse(result);
        if (!vault.folders.root)
          vault.folders.root = {
            id: "root",
            name: "Vault",
            parentId: null,
          };
      } else {
        seedVault();
        scheduleSave();
      }
    } catch (e) {
      console.error("IndexedDB load failed", e);
      seedVault();
      scheduleSave();
    }
    renderAll();
  }

  init();
})();
