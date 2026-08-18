package api

import (
	"database/sql"
	"encoding/json"
	"log"
	"net/http"
	"strings"

	"mysync-server/internal/models"
)

// getBookmarks handles GET /bookmarks
func (r *Router) getBookmarks(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("getBookmarks: begin: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	version, err := r.loadBookmarkVersion(tx, userID)
	if err != nil {
		log.Printf("getBookmarks: version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	nodes, err := r.loadBookmarkNodes(tx, userID)
	if err != nil {
		log.Printf("getBookmarks: nodes: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, models.BookmarksResponse{Version: version, Nodes: nodes})
}

// putBookmarks handles PUT /bookmarks (full tree replace, optimistic version).
func (r *Router) putBookmarks(w http.ResponseWriter, req *http.Request) {
	userID := getUserID(req.Context())
	var body models.BookmarksPutRequest
	if err := json.NewDecoder(req.Body).Decode(&body); err != nil {
		writeError(w, "Invalid JSON payload", http.StatusBadRequest)
		return
	}

	tx, err := r.db.Begin()
	if err != nil {
		log.Printf("putBookmarks: begin: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	defer tx.Rollback()

	_, _ = tx.Exec(`INSERT OR IGNORE INTO bookmark_state (user_id, version) VALUES (?, 0)`, userID)
	var serverVer int64
	if err := tx.QueryRow(`SELECT version FROM bookmark_state WHERE user_id = ?`, userID).Scan(&serverVer); err != nil {
		log.Printf("putBookmarks: load version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	if body.BaseVersion != nil && *body.BaseVersion != serverVer {
		nodes, _ := r.loadBookmarkNodes(tx, userID)
		writeJSONStatus(w, http.StatusConflict, models.BookmarksConflictResponse{
			Error:         "version_conflict",
			ServerVersion: serverVer,
			BaseVersion:   *body.BaseVersion,
			Nodes:         nodes,
			Hint:          "GET /bookmarks then merge and retry with base_version = server version",
		})
		return
	}

	clean, verr := validateBookmarkNodes(body.Nodes)
	if verr != "" {
		writeError(w, verr, http.StatusBadRequest)
		return
	}

	if err := r.applyBookmarkNodes(tx, userID, clean); err != nil {
		log.Printf("putBookmarks: apply nodes: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}

	newVer := serverVer + 1
	if _, err := tx.Exec(`UPDATE bookmark_state SET version = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`, newVer, userID); err != nil {
		log.Printf("putBookmarks: bump version: %v", err)
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	if err := tx.Commit(); err != nil {
		writeError(w, "Database error", http.StatusInternalServerError)
		return
	}
	writeJSON(w, map[string]int64{"version": newVer})
}

func (r *Router) loadBookmarkVersion(tx *sql.Tx, userID string) (int64, error) {
	var v int64
	err := tx.QueryRow(`SELECT version FROM bookmark_state WHERE user_id = ?`, userID).Scan(&v)
	if err == sql.ErrNoRows {
		return 0, nil
	}
	return v, err
}

func (r *Router) loadBookmarkNodes(tx *sql.Tx, userID string) ([]models.BookmarkNode, error) {
	rows, err := tx.Query(`
		SELECT id, parent_id, title, url, position FROM bookmark_nodes
		WHERE user_id = ? ORDER BY position ASC, title ASC
	`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []models.BookmarkNode
	for rows.Next() {
		var id, title string
		var parentID, url sql.NullString
		var pos int
		if err := rows.Scan(&id, &parentID, &title, &url, &pos); err != nil {
			return nil, err
		}
		n := models.BookmarkNode{ID: id, Title: title, Position: pos}
		if parentID.Valid && parentID.String != "" {
			p := parentID.String
			n.ParentID = &p
		}
		if url.Valid && url.String != "" {
			s := url.String
			n.URL = &s
		}
		out = append(out, n)
	}
	return out, rows.Err()
}

// normalizedNode is a validated bookmark_nodes row ready to persist.
type normalizedNode struct {
	ID       string
	ParentID sql.NullString
	Title    string
	URL      sql.NullString
	Position int
}

// validateBookmarkNodes rejects payloads that would corrupt the tree: blank or
// duplicate ids, parents that aren't in the same payload, and parent cycles.
// Without this the server happily stores orphans and loops, which clients then
// have to defend against while walking the tree.
func validateBookmarkNodes(nodes []models.BookmarkNode) ([]normalizedNode, string) {
	out := make([]normalizedNode, 0, len(nodes))
	byID := make(map[string]string, len(nodes)) // id -> parent id ("" = root)

	for _, n := range nodes {
		id := strings.TrimSpace(n.ID)
		if id == "" {
			return nil, "Bookmark node is missing an id"
		}
		if _, dup := byID[id]; dup {
			return nil, "Duplicate bookmark node id: " + id
		}

		var p sql.NullString
		parent := ""
		if n.ParentID != nil {
			parent = strings.TrimSpace(*n.ParentID)
		}
		if parent != "" {
			if parent == id {
				return nil, "Bookmark node is its own parent: " + id
			}
			p = sql.NullString{String: parent, Valid: true}
		}

		var u sql.NullString
		if n.URL != nil {
			if trim := strings.TrimSpace(*n.URL); trim != "" {
				u = sql.NullString{String: trim, Valid: true}
			}
		}

		byID[id] = parent
		out = append(out, normalizedNode{ID: id, ParentID: p, Title: n.Title, URL: u, Position: n.Position})
	}

	// Every non-root parent must be present, and walking upward must terminate.
	for id := range byID {
		seen := map[string]bool{id: true}
		cur := byID[id]
		for cur != "" {
			parent, ok := byID[cur]
			if !ok {
				return nil, "Bookmark node references a missing parent: " + cur
			}
			if seen[cur] {
				return nil, "Bookmark tree contains a parent cycle at: " + cur
			}
			seen[cur] = true
			cur = parent
		}
	}

	return out, ""
}

// applyBookmarkNodes reconciles the stored tree with the submitted one. The
// previous implementation deleted every row and re-inserted the whole payload,
// so renaming one bookmark rewrote thousands of rows; here we only touch what
// actually differs. The wire format is unchanged — this is purely how the
// full-tree PUT lands in the database.
func (r *Router) applyBookmarkNodes(tx *sql.Tx, userID string, nodes []normalizedNode) error {
	existing := make(map[string]normalizedNode)
	rows, err := tx.Query(`SELECT id, parent_id, title, url, position FROM bookmark_nodes WHERE user_id = ?`, userID)
	if err != nil {
		return err
	}
	for rows.Next() {
		var cur normalizedNode
		if err := rows.Scan(&cur.ID, &cur.ParentID, &cur.Title, &cur.URL, &cur.Position); err != nil {
			rows.Close()
			return err
		}
		existing[cur.ID] = cur
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	incoming := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		incoming[n.ID] = true
		prev, ok := existing[n.ID]
		if ok && prev.ParentID == n.ParentID && prev.Title == n.Title && prev.URL == n.URL && prev.Position == n.Position {
			continue
		}
		if ok {
			_, err = tx.Exec(`
				UPDATE bookmark_nodes SET parent_id = ?, title = ?, url = ?, position = ?
				WHERE user_id = ? AND id = ?`,
				n.ParentID, n.Title, n.URL, n.Position, userID, n.ID,
			)
		} else {
			_, err = tx.Exec(`
				INSERT INTO bookmark_nodes (id, user_id, parent_id, title, url, position)
				VALUES (?, ?, ?, ?, ?, ?)`,
				n.ID, userID, n.ParentID, n.Title, n.URL, n.Position,
			)
		}
		if err != nil {
			return err
		}
	}

	for id := range existing {
		if incoming[id] {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM bookmark_nodes WHERE user_id = ? AND id = ?`, userID, id); err != nil {
			return err
		}
	}

	return nil
}
