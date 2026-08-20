/* global APIClient, APIError, StorageManager */
// Bookmark full-tree sync (portable UUID ids in the API for Chrome ↔ Firefox).
/* eslint-disable no-undef */
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  /**
   * The permanent root folders ("Bookmarks bar", "Other bookmarks", …) have
   * different native ids in every browser and cannot be created, renamed, moved
   * or deleted. Giving them well-known slot ids lets Chrome and Firefox agree
   * on where a node belongs, instead of each
   * profile minting a random UUID for its own roots — which made every sync
   * re-create the other browser's roots as ordinary nested folders.
   */
  const ROOT_UUID_PREFIX = 'mysync-root-';

  /** Undo window for sync-initiated deletions. */
  const TRASH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const TRASH_MAX_BATCHES = 20;

  /**
   * Native root ids are fixed per browser, so match on those rather than on
   * position under the root: Chrome has three roots and Firefox four, in a
   * different order, and pairing them by index put Chrome's bookmarks bar
   * opposite Firefox's Bookmarks Menu.
   */
  const ROOT_SLOT_BY_NATIVE = {
    // Chrome / Edge
    '1': 'toolbar',
    '2': 'other',
    '3': 'mobile',
    // Firefox
    toolbar_____: 'toolbar',
    unfiled_____: 'other',
    mobile______: 'mobile',
    menu________: 'menu'
  };

  /** Titles seen on legacy synced roots, for the one-time migration below. */
  const ROOT_SLOT_BY_TITLE = {
    'bookmarks bar': 'toolbar',
    'bookmarks toolbar': 'toolbar',
    favorites: 'toolbar',
    'favorites bar': 'toolbar',
    'other bookmarks': 'other',
    'bookmarks menu': 'menu',
    'mobile bookmarks': 'mobile'
  };

  function rootUUID(slot) {
    return `${ROOT_UUID_PREFIX}${slot}`;
  }

  function isRootUUID(id) {
    return typeof id === 'string' && id.startsWith(ROOT_UUID_PREFIX);
  }

  function rootSlotOf(id) {
    return isRootUUID(id) ? id.slice(ROOT_UUID_PREFIX.length) : null;
  }

  /** Extract `{version}` from the several shapes putBookmarks has returned. */
  function parseVersion(res) {
    if (res == null) {
      return 0;
    }
    if (typeof res === 'object') {
      return Number(res.version) || 0;
    }
    return Number(res) || 0;
  }

  /** Two nodes are "the same" when every synced field matches. */
  function sameNode(a, b) {
    if (!a || !b) {
      return false;
    }
    return (a.parentId || null) === (b.parentId || null) &&
      (a.title || '') === (b.title || '') &&
      (a.url || null) === (b.url || null) &&
      (a.position || 0) === (b.position || 0);
  }

  function indexById(nodes) {
    const m = new Map();
    for (const n of nodes || []) {
      if (n && n.id) {
        m.set(String(n.id), n);
      }
    }
    return m;
  }

  /**
   * Three-way merge of two bookmark trees, the way a sync engine is supposed to
   * settle a version conflict: per node, not per tree.
   *
   * `base` is the tree as it stood at the version both sides branched from (the
   * snapshot we keep after every successful push/pull). It is what makes
   * "missing" distinguishable from "deleted": a node absent from one side but
   * present in base was deleted there, while one absent from base was created
   * on the other side. With no base (first sync after an install) nothing is
   * ever treated as a deletion and the merge degrades to a safe union.
   *
   * Only a node edited on *both* sides since base is a genuine conflict, and
   * there the local edit wins — deterministically, and without discarding
   * anything the other device did to any other node.
   *
   * @param {Array|null} base
   * @param {Array} ours local tree
   * @param {Array} theirs server tree
   */
  function mergeNodeTrees(base, ours, theirs) {
    const hasBase = Array.isArray(base);
    const B = indexById(hasBase ? base : []);
    const O = indexById(ours);
    const T = indexById(theirs);
    const out = [];
    const stats = { kept: 0, fromLocal: 0, fromRemote: 0, deleted: 0, conflicts: 0 };

    const ids = new Set([...O.keys(), ...T.keys()]);
    for (const id of ids) {
      const o = O.get(id);
      const t = T.get(id);
      const b = hasBase ? B.get(id) : undefined;

      if (o && t) {
        if (sameNode(o, t)) {
          out.push(o);
          stats.kept++;
        } else if (b && sameNode(b, t)) {
          out.push(o); // only we changed it
          stats.fromLocal++;
        } else if (b && sameNode(b, o)) {
          out.push(t); // only the other device changed it
          stats.fromRemote++;
        } else {
          out.push(o); // both changed it — local edit wins
          stats.conflicts++;
        }
        continue;
      }
      if (o && !t) {
        if (b) {
          stats.deleted++; // the other device deleted it
        } else {
          out.push(o); // we created it
          stats.fromLocal++;
        }
        continue;
      }
      if (t && !o) {
        if (b) {
          stats.deleted++; // we deleted it
        } else {
          out.push(t); // the other device created it
          stats.fromRemote++;
        }
      }
    }
    return { nodes: out, stats };
  }

  /**
   * Cap on the merge-base snapshot we keep in extension storage. Beyond this a
   * tree is large enough that persisting a second copy is the bigger problem;
   * the merge falls back to its no-base union behaviour, which never deletes.
   */
  const SNAPSHOT_MAX_NODES = 20000;

  /** Trim a node list down to just the fields the merge compares. */
  function snapshotNodes(nodes) {
    if (!Array.isArray(nodes) || nodes.length > SNAPSHOT_MAX_NODES) {
      return null;
    }
    return nodes.map((n) => ({
      id: n.id,
      parentId: n.parentId != null && n.parentId !== '' ? n.parentId : null,
      title: n.title || '',
      url: n.url != null && n.url !== '' ? n.url : null,
      position: n.position || 0
    }));
  }

  function newUUID() {
    if (globalScope.crypto && typeof globalScope.crypto.randomUUID === 'function') {
      return globalScope.crypto.randomUUID();
    }
    return `bs-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  class BookmarkManager {
    constructor(service) {
      this.service = service;
      this.api = service.apiClient;
      this.storage = service.storage;
      this.ext = service.ext;
      this._debounce = null;
      this._pushInFlight = null;
      this._listenersAttached = false;
      /**
       * True while applyFromServer() is mutating the local tree. Our own
       * create/move/update/remove calls fire the same onCreated/onRemoved/
       * onChanged/onMoved listeners we use to detect *user* edits, so without
       * this flag every pull echoes straight back out as a push.
       */
      this._applying = false;
      /**
       * Bumped on every local bookmark event. _doPush() captures it before it
       * builds the payload and only clears localDirty if it is unchanged when
       * the upload lands, so an edit made *during* a push is not marked synced.
       */
      this._dirtyToken = 0;
    }

    hasBookmarksAPI() {
      return !!(this.ext && this.ext.bookmarks && typeof this.ext.bookmarks.getTree === 'function');
    }

    async initialize() {
      if (!this.hasBookmarksAPI()) {
        return;
      }
      await this._migrateConflictDefault();
      await this.setupAlarm();
      this.attachListeners();
    }

    /**
     * "Ask me" was the old default, and it fired on version bumps no user had
     * caused. Now that conflicts merge, move profiles that never chose anything
     * else onto the merging default — once, so an explicit later choice sticks.
     */
    async _migrateConflictDefault() {
      try {
        if (await this.storage.get('bookmarkConflictMergeMigration', false)) {
          return;
        }
        await this.storage.set('bookmarkConflictMergeMigration', true);
        const c = await this.storage.getConfig();
        if (!c.bookmarkConflictAction || c.bookmarkConflictAction === 'prompt') {
          await this.storage.setConfig({ bookmarkConflictAction: 'auto_merge' });
        }
      } catch (e) {
        logger.warn('BookmarkManager: conflict-default migration', e);
      }
    }

    async setupAlarm() {
      try {
        await this.ext.alarms.clear('bookmarkSync');
        const c = await this.storage.getConfig();
        if (c.bookmarkSyncEnabled === false) {
          return;
        }
        // 15 minutes between polls meant a bookmark added on one device could sit
        // invisible on the others for a quarter of an hour, and gave local edits a
        // long window in which to diverge from the server. Poll soon after start-up
        // and every few minutes after that.
        this.ext.alarms.create('bookmarkSync', { delayInMinutes: 0.5, periodInMinutes: 5 });
      } catch (e) {
        logger.warn('BookmarkManager: could not set alarm', e);
      }
    }

    attachListeners() {
      if (!this.hasBookmarksAPI()) {
        return;
      }
      if (this._listenersAttached) {
        return;
      }
      this._listenersAttached = true;
      const b = this.ext.bookmarks;
      const onChange = () => this.scheduleDebounce();
      b.onCreated.addListener(onChange);
      b.onRemoved.addListener((id) => {
        void this.onNativeRemoved(id);
        onChange();
      });
      b.onChanged.addListener(onChange);
      b.onMoved.addListener(onChange);
    }

    async onNativeRemoved(nativeId) {
      // Removals we performed ourselves are already reflected in the in-memory
      // maps applyFromServer is holding; writing storage here would race with
      // its final setBookmarkIdMaps() and resurrect stale entries.
      if (this._applying) {
        return;
      }
      const s = String(nativeId);
      const maps = await this.storage.getBookmarkIdMaps();
      const u = maps.nativeToUUID && maps.nativeToUUID[s];
      if (u) {
        delete maps.nativeToUUID[s];
        if (maps.uuidToNative) delete maps.uuidToNative[u];
        await this.storage.setBookmarkIdMaps(maps);
      }
    }

    scheduleDebounce() {
      if (this._applying) {
        return;
      }
      if (this._debounce) {
        clearTimeout(this._debounce);
      }
      this._debounce = setTimeout(() => {
        this._debounce = null;
        void this.markDirtyAndSync();
      }, 1500);
    }

    async markDirtyAndSync() {
      this._dirtyToken++;
      await this.storage.setBookmarkSyncState({ localDirty: true });
      const c = await this.storage.getConfig();
      if (c.bookmarkSyncEnabled === false) {
        return;
      }
      if (c.bookmarkSyncDirection === 'upload_only' || c.bookmarkSyncDirection === 'bidirectional') {
        void this.push().catch((e) => logger.warn('Bookmark push', e));
      }
    }

    async runSync() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      const c = await this.storage.getConfig();
      if (c.bookmarkSyncEnabled === false) {
        return;
      }
      if (c.bookmarkSyncDirection === 'upload_only' || c.bookmarkSyncDirection === 'bidirectional') {
        const st = await this.storage.getBookmarkSyncState();
        // A device that has never synced has to upload once even though nothing
        // is "dirty", otherwise its bookmarks only reach the server on the next
        // edit.
        if (st.localDirty || st.lastSyncedAt == null) {
          await this.push();
        }
      }
      if (c.bookmarkSyncDirection === 'download_only' || c.bookmarkSyncDirection === 'bidirectional') {
        // Previously a device with unpushed edits skipped the pull entirely, so
        // its lastServerVersion stayed stale and the *next* push was rejected as
        // a conflict. pull() now merges in that case instead of skipping.
        await this.pull();
      }
    }

    /**
     * Export flat nodes with stable UUIDs for API and server.
     */
    async buildNodesForServer() {
      const maps = await this.storage.getBookmarkIdMaps();
      const tree = await this.ext.bookmarks.getTree();
      const out = [];
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };
      const uuidToNative = { ...(maps.uuidToNative || {}) };
      await this._seedRootMappings(nativeToUUID, uuidToNative);

      const visit = (nodes, _depth) => {
        if (!nodes) return;
        for (let i = 0; i < nodes.length; i++) {
          const n = nodes[i];
          if (!n) continue;
          if (n.id === '0' || n.parentId == null) {
            if (n.children) visit(n.children, _depth);
            continue;
          }
          const nid = String(n.id);
          let uuid = nativeToUUID[nid];
          if (!uuid) {
            uuid = newUUID();
            nativeToUUID[nid] = uuid;
            uuidToNative[uuid] = nid;
          }
          let parentUUID = null;
          if (n.parentId != null && n.parentId !== '') {
            const pid = String(n.parentId);
            if (pid === '0') {
              parentUUID = null;
            } else {
              parentUUID = nativeToUUID[pid];
              if (!parentUUID) {
                parentUUID = newUUID();
                nativeToUUID[pid] = parentUUID;
                uuidToNative[parentUUID] = pid;
              }
            }
          }
          out.push({
            id: uuid,
            parentId: parentUUID,
            title: n.title || '',
            url: n.url != null && n.url !== '' ? n.url : null,
            position: i
          });
          if (n.children && n.children.length) {
            visit(n.children, _depth + 1);
          }
        }
      };

      if (tree && tree[0] && tree[0].children) {
        visit(tree[0].children, 0);
      }

      await this.storage.setBookmarkIdMaps({ nativeToUUID, uuidToNative });
      return { nodes: out, maps: { nativeToUUID, uuidToNative } };
    }

    /**
     * @param {{force?: boolean}} [opts]
     */
    async push(opts) {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      const st = await this.storage.getBookmarkSyncState();
      // Uploading an unchanged tree used to be harmless-looking but was the main
      // source of phantom conflicts: every PUT bumped the server version, so a
      // device that merely ran a periodic sync invalidated every other device's
      // base_version. Nothing local changed -> nothing to send.
      if (!st.localDirty && st.lastSyncedAt != null && !(opts && opts.force)) {
        return;
      }
      if (this._pushInFlight) {
        return this._pushInFlight;
      }
      this._pushInFlight = this._doPush();
      try {
        await this._pushInFlight;
      } finally {
        this._pushInFlight = null;
      }
    }

    /**
     * Repair a node list before it goes to the server: drop blank ids and
     * duplicates, re-parent orphans onto the nearest surviving ancestor, and
     * root the shallowest member of any parent cycle. The server rejects all
     * three with a 400, and a browser profile in a strange state would
     * otherwise retry that rejection forever with no way out.
     */
    _sanitizeNodes(nodes) {
      const byId = new Map();
      const clean = [];
      let repaired = 0;

      for (const n of nodes) {
        if (!n || !n.id || String(n.id).trim() === '') {
          repaired++;
          continue;
        }
        const id = String(n.id);
        if (byId.has(id)) {
          repaired++;
          continue;
        }
        const node = { ...n, id };
        byId.set(id, node);
        clean.push(node);
      }

      for (const n of clean) {
        if (n.parentId == null || n.parentId === '') {
          n.parentId = null;
          continue;
        }
        // Walk up; root the node if the chain leaves the set or loops.
        const seen = new Set([n.id]);
        let cur = n.parentId;
        let ok = true;
        while (cur != null && cur !== '') {
          if (seen.has(cur) || !byId.has(cur)) {
            ok = false;
            break;
          }
          seen.add(cur);
          cur = byId.get(cur).parentId;
        }
        if (!ok) {
          n.parentId = null;
          repaired++;
        }
      }

      if (repaired > 0) {
        logger.warn('Bookmark sanitise: repaired', repaired, 'malformed node(s) before upload');
      }
      return clean;
    }

    async _doPush() {
      const built = await this.buildNodesForServer();
      const nodes = this._sanitizeNodes(built.nodes);
      const st = await this.storage.getBookmarkSyncState();
      const token = this._dirtyToken;
      const body = {
        base_version: st.lastServerVersion != null ? st.lastServerVersion : 0,
        nodes
      };
      let res;
      let stored = nodes;
      let applyLocally = false;
      try {
        res = await this.api.putBookmarks(body);
      } catch (e) {
        if (e && e.name === 'APIError' && e.statusCode === 409 && e.body) {
          const handled = await this._handle409(e.body, body);
          if (handled == null) {
            return;
          }
          res = handled.res;
          stored = handled.nodes;
          applyLocally = !!handled.applyLocally;
        } else {
          await this.storage.setBookmarkSyncState({ lastError: (e && e.message) || 'push_failed' });
          throw e;
        }
      }
      const v = parseVersion(res);
      if (applyLocally) {
        // The merged tree contains the other device's work too; put it on this
        // profile so both sides really do end up identical. This runs before the
        // state write below because applyFromServer() writes sync state of its
        // own and would otherwise clear the mid-flight dirty flag.
        await this.applyFromServer(v, stored, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
      }
      await this.storage.setBookmarkSyncState({
        lastServerVersion: v,
        lastServerNodes: snapshotNodes(stored),
        // Edits that landed while the upload was in flight are not covered by
        // it; leaving the flag set makes the next sync pick them up instead of
        // silently dropping them until the user touches a bookmark again.
        localDirty: this._dirtyToken !== token,
        lastSyncedAt: Date.now(),
        lastError: null,
        pendingConflict: null
      });
    }

    /**
     * @returns {Promise<{res: object, nodes: Array, applyLocally?: boolean}|null>}
     *   upload result, or null when the conflict was consumed (server applied,
     *   or parked for the user).
     */
    async _handle409(conflict, body) {
      const cfg = await this.storage.getConfig();
      const act = cfg.bookmarkConflictAction || 'auto_merge';
      const del = (await this._deletePolicy()) === 'match_server';
      if (act === 'use_server' || (act === 'auto_prefer' && cfg.bookmarkAutoResolution === 'server_wins')) {
        await this.applyFromServer(
          conflict.server_version,
          conflict.nodes || [],
          { deleteOrphans: del }
        );
        await this.storage.setBookmarkSyncState({
          localDirty: false,
          lastError: null,
          pendingConflict: null,
          lastServerNodes: snapshotNodes(conflict.nodes || []),
          lastServerVersion: conflict.server_version
        });
        return null;
      }
      // "local wins" is not a preference, it is a destructive overwrite: it
      // discards whatever the other device pushed, unseen. An explicit
      // use_local came from the conflict prompt, so it is already consented to.
      // The automatic path needs a one-time acknowledgement first.
      const autoLocal = act === 'auto_prefer' && cfg.bookmarkAutoResolution === 'local_wins';
      if (act === 'use_local' || (autoLocal && cfg.bookmarkLocalWinsAcknowledged === true)) {
        const next = { ...body, base_version: conflict.server_version };
        return { res: await this.api.putBookmarks(next), nodes: body.nodes };
      }
      if (act !== 'prompt' && act !== 'auto_prefer') {
        // Default path: settle it the way Chrome does — merge the two trees
        // node by node and upload the result. Only a node both devices edited
        // is a real conflict, and it does not need the user's attention.
        const merged = await this._mergeAndUpload(conflict, body.nodes);
        if (merged) {
          return merged;
        }
      }
      await this.storage.setBookmarkSyncState({
        pendingConflict: { ...conflict, overwritesServer: autoLocal },
        lastError: autoLocal ? 'local_wins_needs_ack' : 'version_conflict'
      });
      return null;
    }

    /**
     * Merge the server tree from a 409 with our local tree and upload the
     * result at the server's version. Returns null if even the merged upload is
     * rejected (another device pushed again in between) so the caller can fall
     * back to parking the conflict.
     */
    async _mergeAndUpload(conflict, ourNodes) {
      const st = await this.storage.getBookmarkSyncState();
      const serverNodes = Array.isArray(conflict.nodes) ? conflict.nodes : [];
      const { nodes: raw, stats } = mergeNodeTrees(st.lastServerNodes || null, ourNodes, serverNodes);
      const merged = this._sanitizeNodes(raw);
      logger.info('Bookmark conflict merged automatically', stats);
      try {
        const res = await this.api.putBookmarks({
          base_version: conflict.server_version,
          nodes: merged
        });
        return { res, nodes: merged, applyLocally: true };
      } catch (e) {
        logger.warn('Bookmark merge upload rejected', e && e.message);
        return null;
      }
    }

    /**
     * The server moved on while we still hold unpushed local edits. Merge the
     * two and upload, rather than skipping the pull (which left our recorded
     * version stale and guaranteed a conflict on the next push).
     */
    async _mergeAndPush(serverVersion, serverNodes) {
      const built = await this.buildNodesForServer();
      const ours = this._sanitizeNodes(built.nodes);
      const st = await this.storage.getBookmarkSyncState();
      const token = this._dirtyToken;
      const { nodes: raw, stats } = mergeNodeTrees(st.lastServerNodes || null, ours, serverNodes);
      const merged = this._sanitizeNodes(raw);
      logger.info('Bookmark pull merged with local edits', stats);
      const body = { base_version: serverVersion, nodes: merged };
      let res;
      let stored = merged;
      try {
        res = await this.api.putBookmarks(body);
      } catch (e) {
        // A third device can push between our GET and our PUT. Re-run the same
        // conflict path rather than throwing; the next merge just has a newer
        // server tree to fold in.
        if (e && e.name === 'APIError' && e.statusCode === 409 && e.body) {
          const handled = await this._handle409(e.body, body);
          if (handled == null) {
            return;
          }
          res = handled.res;
          stored = handled.nodes;
        } else {
          await this.storage.setBookmarkSyncState({ lastError: (e && e.message) || 'merge_push_failed' });
          throw e;
        }
      }
      const v = parseVersion(res);
      await this.applyFromServer(v, stored, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
      await this.storage.setBookmarkSyncState({
        lastServerVersion: v,
        lastServerNodes: snapshotNodes(stored),
        localDirty: this._dirtyToken !== token,
        lastSyncedAt: Date.now(),
        lastError: null,
        pendingConflict: null
      });
    }

    /**
     * @param {string} [policy] match_server | keep_local
     */
    async _deletePolicy(policy) {
      const c = await this.storage.getConfig();
      return policy || c.bookmarkDeletePolicy || 'match_server';
    }

    async pull() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
        return;
      }
      const raw = await this.api.getBookmarks();
      const version = raw.version != null ? raw.version : 0;
      const nodes = Array.isArray(raw.nodes) ? raw.nodes : [];
      const st = await this.storage.getBookmarkSyncState();
      if (version === st.lastServerVersion) {
        // Same version we already hold: remember the tree so the next merge has
        // a base to compare against even if we have never pushed.
        if (!st.lastServerNodes) {
          await this.storage.setBookmarkSyncState({ lastServerNodes: snapshotNodes(nodes) });
        }
        return;
      }
      if (st.localDirty) {
        await this._mergeAndPush(version, nodes);
        return;
      }
      await this.applyFromServer(version, nodes, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
    }

    /**
     * Apply server list (UUID parent ids) to the local profile.
     */
    async applyFromServer(version, nodes, opts) {
      this._applying = true;
      try {
        return await this._applyFromServer(version, nodes, opts);
      } finally {
        if (this._debounce) {
          clearTimeout(this._debounce);
          this._debounce = null;
        }
        // Bookmark events are delivered a tick or two after the API call
        // resolves, so hold the guard briefly past the last write.
        setTimeout(() => {
          this._applying = false;
        }, 3000);
      }
    }

    /**
     * Bind this profile's root folders to the well-known root ids, overwriting
     * any random UUID a previous version assigned them. Mutates the maps in
     * place and returns the protected native id set.
     */
    async _seedRootMappings(nativeToUUID, uuidToNative) {
      const protectedIds = new Set(['0']);
      let root = null;
      try {
        const t = await this.ext.bookmarks.getTree();
        root = t && t[0];
      } catch (e) {
        logger.warn('BookmarkManager: could not read root ids', e);
        return protectedIds;
      }
      if (!root) {
        return protectedIds;
      }
      protectedIds.add(String(root.id));
      const children = root.children || [];
      for (let i = 0; i < children.length; i++) {
        const nid = String(children[i].id);
        protectedIds.add(nid);
        // Unknown browsers fall back to position, which is at least stable
        // within that profile.
        const slot = ROOT_SLOT_BY_NATIVE[nid] || `pos${i}`;
        const uuid = rootUUID(slot);
        const stale = nativeToUUID[nid];
        if (stale && stale !== uuid) {
          delete uuidToNative[stale];
        }
        nativeToUUID[nid] = uuid;
        uuidToNative[uuid] = nid;
      }
      return protectedIds;
    }

    /**
     * Resolve a server root id to a local folder. Firefox's Bookmarks Menu has
     * no Chrome equivalent, so an unrepresented slot lands in "Other bookmarks"
     * rather than being scattered into the toolbar.
     */
    _resolveRootParent(rootId, uuidToNative, topParentId) {
      const direct = uuidToNative[rootId];
      if (direct) {
        return String(direct);
      }
      const other = uuidToNative[rootUUID('other')];
      return other ? String(other) : topParentId;
    }

    /**
     * One-time migration. Before roots had well-known ids each profile minted a
     * random UUID for its own roots and pushed them as ordinary nodes, so the
     * server still holds a top-level folder titled "Bookmarks bar" whose
     * children point at it. Rewrite those children onto the real root and drop
     * the placeholder, so the tree lands where it belongs instead of nesting a
     * second bookmarks bar inside the first.
     *
     * @returns {{nodes: Array, changed: boolean}}
     */
    _normalizeLegacyRoots(nodes) {
      const remap = new Map();
      for (const n of nodes) {
        if (!n || !n.id || isRootUUID(n.id)) {
          continue;
        }
        const isTopLevel = n.parentId == null || n.parentId === '';
        const isFolder = !n.url;
        if (!isTopLevel || !isFolder) {
          continue;
        }
        const slot = ROOT_SLOT_BY_TITLE[String(n.title || '').trim().toLowerCase()];
        if (slot) {
          remap.set(n.id, rootUUID(slot));
        }
      }
      if (remap.size === 0) {
        return { nodes, changed: false };
      }
      const out = [];
      for (const n of nodes) {
        if (!n || remap.has(n.id)) {
          continue; // placeholder root: the local one already exists
        }
        const target = n.parentId != null ? remap.get(n.parentId) : null;
        out.push(target ? { ...n, parentId: target } : n);
      }
      logger.info('Bookmark migration: rewrote', remap.size, 'legacy root folder(s)');
      return { nodes: out, changed: true };
    }

    /**
     * Re-link server nodes to local ones by where they sit and what they are,
     * for the case where the two sides hold the same bookmarks under different
     * ids: a reinstall (id maps live in extension storage and are lost), a
     * cleared server, or a second device syncing for the first time. Without
     * this every node looks new, so the tree is duplicated and the old copy
     * swept as orphans.
     *
     * Matching is on the path from the root plus the URL (bookmarks) or title
     * (folders), with an occurrence counter so duplicate siblings stay distinct.
     *
     * @returns {Promise<number>} nodes adopted
     */
    async _adoptByContent(nodes, nativeToUUID, uuidToNative) {
      const unmapped = nodes.filter((n) => n && n.id && !uuidToNative[n.id]);
      if (unmapped.length === 0) {
        return 0;
      }

      const nodeKey = (title, url) => (url ? `u:${url}` : `f:${String(title || '')}`);

      // --- local side: path key -> native id (ambiguous keys are dropped) ---
      const localByKey = new Map();
      const ambiguous = new Set();
      let root = null;
      try {
        const t = await this.ext.bookmarks.getTree();
        root = t && t[0];
      } catch (e) {
        return 0;
      }
      const walkLocal = (children, prefix) => {
        const seen = new Map();
        for (const c of children || []) {
          const base = `${prefix}/${nodeKey(c.title, c.url)}`;
          const n = (seen.get(base) || 0) + 1;
          seen.set(base, n);
          const key = `${base}#${n}`;
          if (localByKey.has(key)) {
            ambiguous.add(key);
          } else {
            localByKey.set(key, String(c.id));
          }
          if (c.children) {
            walkLocal(c.children, key);
          }
        }
      };
      for (const r of (root && root.children) || []) {
        const slot = ROOT_SLOT_BY_NATIVE[String(r.id)];
        if (slot) {
          walkLocal(r.children, `@${slot}`);
        }
      }

      // --- server side: same keys, computed top-down ---
      const childrenOf = new Map();
      for (const n of nodes) {
        if (!n || !n.id) continue;
        const pid = n.parentId == null ? '' : n.parentId;
        if (!childrenOf.has(pid)) childrenOf.set(pid, []);
        childrenOf.get(pid).push(n);
      }
      for (const list of childrenOf.values()) {
        list.sort((a, b) => (a.position || 0) - (b.position || 0));
      }

      let adopted = 0;
      const walkServer = (parentId, prefix) => {
        const seen = new Map();
        for (const n of childrenOf.get(parentId) || []) {
          const base = `${prefix}/${nodeKey(n.title, n.url)}`;
          const c = (seen.get(base) || 0) + 1;
          seen.set(base, c);
          const key = `${base}#${c}`;
          if (!uuidToNative[n.id] && !ambiguous.has(key)) {
            const nid = localByKey.get(key);
            // Only claim a local node that nothing else owns.
            if (nid && !nativeToUUID[nid]) {
              uuidToNative[n.id] = nid;
              nativeToUUID[nid] = n.id;
              adopted++;
            }
          }
          walkServer(n.id, key);
        }
      };
      let sawRoot = false;
      for (const n of nodes) {
        const slot = rootSlotOf(n && n.id);
        if (slot) {
          sawRoot = true;
          walkServer(n.id, `@${slot}`);
        }
      }
      if (!sawRoot) {
        // Payload from a server that predates root slots: treat top level as
        // "other" rather than leaving every node unmatched.
        walkServer('', '@other');
      }

      if (adopted > 0) {
        logger.info('Bookmark adoption: re-linked', adopted, 'existing node(s) by content');
      }
      return adopted;
    }

    async _applyFromServer(version, nodes, opts) {
      const deleteOrphans = opts && opts.deleteOrphans;
      const byId = new Map();
      for (const n of nodes) {
        if (n && n.id) {
          byId.set(n.id, n);
        }
      }
      if (nodes.length === 0) {
        await this.storage.setBookmarkSyncState({
          lastServerVersion: version,
          lastServerNodes: [],
          lastSyncedAt: Date.now()
        });
        return;
      }

      const maps = await this.storage.getBookmarkIdMaps();
      const uuidToNative = { ...(maps.uuidToNative || {}) };
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };

      const protectedIds = await this._seedRootMappings(nativeToUUID, uuidToNative);
      const topParentId = await this.getDefaultParentId();

      const legacy = this._normalizeLegacyRoots(nodes);
      if (legacy.changed) {
        nodes = legacy.nodes;
        byId.clear();
        for (const n of nodes) {
          if (n && n.id) byId.set(n.id, n);
        }
      }

      // Claim nodes we already hold under different ids *before* anything is
      // created or swept, so a reinstall re-links instead of duplicating.
      await this._adoptByContent(nodes, nativeToUUID, uuidToNative);
      const depthMemo = new Map();
      // `visiting` breaks parent cycles. The server rejects them now, but a
      // pre-fix database can still hold one and this recursion would not
      // terminate — depthMemo is only written *after* the recursive call.
      const visiting = new Set();
      const depth = (id) => {
        if (depthMemo.has(id)) {
          return depthMemo.get(id);
        }
        const n = byId.get(id);
        if (!n) {
          depthMemo.set(id, 999);
          return 999;
        }
        const p = n.parentId;
        if (p == null || p === '') {
          depthMemo.set(id, 0);
          return 0;
        }
        if (visiting.has(id)) {
          logger.warn('Bookmark parent cycle detected at', id);
          depthMemo.set(id, 999);
          return 999;
        }
        visiting.add(id);
        const d = 1 + depth(p);
        visiting.delete(id);
        depthMemo.set(id, d);
        return d;
      };

      const ordered = [...nodes].sort((a, b) => {
        const da = depth(a.id);
        const db = depth(b.id);
        if (da !== db) {
          return da - db;
        }
        return (a.position || 0) - (b.position || 0);
      });

      for (const n of ordered) {
        if (!n || !n.id) {
          continue;
        }
        const local = uuidToNative[n.id] ? String(uuidToNative[n.id]) : null;
        // A root node from the other browser is already represented by this
        // profile's own root at the same slot; there is nothing to create,
        // rename or move, and attempting it throws.
        if (isRootUUID(n.id) || (local && protectedIds.has(local))) {
          continue;
        }
        const parentIdForCreate = isRootUUID(n.parentId)
          ? this._resolveRootParent(n.parentId, uuidToNative, topParentId)
          : n.parentId && uuidToNative[n.parentId]
            ? String(uuidToNative[n.parentId])
            : topParentId;

        if (local) {
          try {
            const cur = (await this.ext.bookmarks.get(local))[0];
            if (cur) {
              const isFolder = !n.url || n.url === '';
              const updates = { title: n.title || '' };
              if (!isFolder) {
                updates.url = n.url;
              }
              if (String(cur.parentId) !== String(parentIdForCreate)) {
                try {
                  await this.ext.bookmarks.move(local, { parentId: parentIdForCreate, index: n.position || 0 });
                } catch (e) {
                  logger.warn('Bookmark move', e);
                }
              }
              try {
                await this.ext.bookmarks.update(local, updates);
              } catch (e) {
                logger.warn('Bookmark update', e);
              }
            } else {
              await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
            }
          } catch {
            await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
          }
        } else {
          await this._create(n, parentIdForCreate, n.position || 0, uuidToNative, nativeToUUID);
        }
      }

      if (deleteOrphans) {
        const serverSet = new Set(nodes.map((x) => x && x.id).filter(Boolean));
        // Roots are always mapped and always present; they'd mask a genuine
        // divergence, so judge overlap on real content only.
        const mapped = Object.keys(uuidToNative).filter((u) => !isRootUUID(u));
        const overlap = mapped.filter((u) => serverSet.has(u)).length;

        // The sweep assumes "mapped locally but absent from the server" means
        // "deleted on another device". That only holds while both sides share
        // an id space. After a reinstall, an account purge, or a first sync
        // against a tree another device built from its *own* fresh UUIDs, every
        // local id looks orphaned and the sweep deletes the entire profile.
        // Zero overlap is never a legitimate delete — surface it instead.
        if (mapped.length > 0 && overlap === 0) {
          logger.warn(
            'Bookmark orphan sweep aborted: server tree shares no ids with the local map',
            { local: mapped.length, server: serverSet.size }
          );
          await this.storage.setBookmarkSyncState({
            lastError: 'id_space_diverged',
            pendingConflict: { server_version: version, nodes }
          });
        } else {
          const doomed = mapped.filter((u) => !serverSet.has(u));
          // The zero-overlap check above catches total divergence, but not a
          // bug that would take most of a tree with it. Anything past half is
          // not a sync, it is an accident — park it for a human instead.
          if (mapped.length >= 10 && doomed.length > mapped.length / 2) {
            logger.warn('Bookmark orphan sweep aborted: would remove', doomed.length, 'of', mapped.length);
            await this.storage.setBookmarkSyncState({
              lastError: 'bulk_delete_blocked',
              pendingConflict: { server_version: version, nodes }
            });
          } else {
            for (const u of doomed) {
              const nid = uuidToNative[u];
              if (nid && !protectedIds.has(String(nid))) {
                await this._trashSubtree(String(nid));
                try {
                  // remove() rejects on non-empty folders; removeTree() covers both.
                  await this.ext.bookmarks.removeTree(String(nid));
                } catch (e) {
                  logger.warn('Bookmark orphan remove', e);
                }
              }
              delete uuidToNative[u];
              if (nid && nativeToUUID[nid]) {
                delete nativeToUUID[nid];
              }
            }
          }
        }
      }

      for (const u of Object.keys(uuidToNative)) {
        const nid = uuidToNative[u];
        if (nid) {
          nativeToUUID[nid] = u;
        }
      }

      await this.storage.setBookmarkIdMaps({ nativeToUUID, uuidToNative });
      await this.storage.setBookmarkSyncState({
        lastServerVersion: version,
        // The merge base for the next conflict: what the server held at this
        // version. Without it a merge cannot tell a deletion from an addition.
        lastServerNodes: snapshotNodes(nodes),
        lastSyncedAt: Date.now(),
        lastError: null,
        localDirty: legacy.changed
      });
      if (legacy.changed) {
        // The server still holds the placeholder roots; upload the corrected
        // tree once so other devices never see them again.
        void this.push().catch((e) => logger.warn('Bookmark legacy-root push', e));
      }
    }

    /**
     * Record a subtree before deleting it, so a sync that removes the wrong
     * thing is an annoyance rather than a loss. Capped and time-limited; this
     * is an undo window, not a second copy of the user's bookmarks.
     */
    async _trashSubtree(nativeId) {
      try {
        const sub = await this.ext.bookmarks.getSubTree(nativeId);
        const items = [];
        const flatten = (node, path) => {
          if (!node) return;
          const here = path ? `${path}/${node.title || ''}` : node.title || '';
          if (node.url) {
            items.push({ title: node.title || '', url: node.url, path });
          }
          for (const c of node.children || []) {
            flatten(c, here);
          }
        };
        for (const node of sub || []) {
          flatten(node, '');
        }
        if (items.length === 0) {
          return;
        }
        const trash = await this.storage.get('bookmarkTrash', []);
        const cutoff = Date.now() - TRASH_TTL_MS;
        const kept = (Array.isArray(trash) ? trash : []).filter((e) => e && e.deletedAt > cutoff);
        kept.push({ deletedAt: Date.now(), items });
        await this.storage.set('bookmarkTrash', kept.slice(-TRASH_MAX_BATCHES));
      } catch (e) {
        logger.warn('Bookmark trash capture failed', e);
      }
    }

    /** Recreate everything still inside the undo window, into "Other bookmarks". */
    async restoreTrash() {
      const trash = await this.storage.get('bookmarkTrash', []);
      const cutoff = Date.now() - TRASH_TTL_MS;
      const batches = (Array.isArray(trash) ? trash : []).filter((e) => e && e.deletedAt > cutoff);
      if (batches.length === 0) {
        return { ok: true, restored: 0 };
      }
      const maps = await this.storage.getBookmarkIdMaps();
      const uuidToNative = { ...(maps.uuidToNative || {}) };
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };
      await this._seedRootMappings(nativeToUUID, uuidToNative);
      const parentId = this._resolveRootParent(
        rootUUID('other'),
        uuidToNative,
        await this.getDefaultParentId()
      );

      let restored = 0;
      this._applying = true;
      try {
        const folder = await this.ext.bookmarks.create({
          parentId,
          title: `Restored bookmarks ${new Date().toLocaleDateString()}`
        });
        for (const batch of batches) {
          for (const it of batch.items || []) {
            try {
              await this.ext.bookmarks.create({
                parentId: String(folder.id),
                title: it.path ? `${it.path} — ${it.title}` : it.title,
                url: it.url
              });
              restored++;
            } catch (e) {
              logger.warn('Bookmark restore item failed', e);
            }
          }
        }
      } finally {
        setTimeout(() => {
          this._applying = false;
        }, 3000);
      }
      await this.storage.set('bookmarkTrash', []);
      return { ok: true, restored };
    }

    async trashSummary() {
      const trash = await this.storage.get('bookmarkTrash', []);
      const cutoff = Date.now() - TRASH_TTL_MS;
      const batches = (Array.isArray(trash) ? trash : []).filter((e) => e && e.deletedAt > cutoff);
      return {
        batches: batches.length,
        items: batches.reduce((n, b) => n + ((b.items && b.items.length) || 0), 0),
        newestAt: batches.length ? Math.max(...batches.map((b) => b.deletedAt)) : null
      };
    }

    async _create(n, parentId, index, uuidToNative, nativeToUUID) {
      const isFolder = !n.url || n.url === '';
      const created = await this.ext.bookmarks.create({
        parentId,
        index,
        title: n.title || '',
        url: isFolder ? undefined : n.url
      });
      const newId = String(created.id);
      uuidToNative[n.id] = newId;
      nativeToUUID[newId] = n.id;
    }

    async getDefaultParentId() {
      const t = await this.ext.bookmarks.getTree();
      const root = t && t[0];
      const ch = (root && root.children) || [];
      if (ch[0]) {
        return String(ch[0].id);
      }
      return '1';
    }

    async resolveConflict(choice) {
      const st = await this.storage.getBookmarkSyncState();
      const p = st.pendingConflict;
      if (!p) {
        return { ok: false, error: 'no_conflict' };
      }
      if (choice === 'use_server' || choice === 'server') {
        const nodes = p.nodes || [];
        const sv = p.serverVersion != null ? p.serverVersion : p.server_version;
        await this.applyFromServer(sv, nodes, { deleteOrphans: (await this._deletePolicy()) === 'match_server' });
        await this.storage.setBookmarkSyncState({
          pendingConflict: null,
          lastError: null,
          lastServerNodes: snapshotNodes(p.nodes || [])
        });
        return { ok: true };
      }
      if (choice === 'use_local' || choice === 'local') {
        // Choosing this at the prompt is the acknowledgement that unblocks the
        // automatic local_wins path for later conflicts.
        await this.storage.setConfig({ bookmarkLocalWinsAcknowledged: true });
        const built = await this.buildNodesForServer();
        const nodes = this._sanitizeNodes(built.nodes);
        const sv = p.serverVersion != null ? p.serverVersion : p.server_version;
        const body = { base_version: sv, nodes };
        const res = await this.api.putBookmarks(body);
        const v = parseVersion(res);
        await this.storage.setBookmarkSyncState({
          lastServerVersion: v,
          lastServerNodes: snapshotNodes(nodes),
          localDirty: false,
          pendingConflict: null,
          lastError: null
        });
        return { ok: true, version: v };
      }
      return { ok: false, error: 'unknown_choice' };
    }
  }

  globalScope.BookmarkManager = BookmarkManager;
  // Exported for tests: the merge is the part worth pinning down.
  globalScope.mergeBookmarkTrees = mergeNodeTrees;
})(typeof self !== 'undefined' ? self : window);
