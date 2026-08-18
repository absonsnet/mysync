/* global APIClient, APIError, StorageManager */
// Bookmark full-tree sync (portable UUID ids in the API for Chrome ↔ Firefox).
/* eslint-disable no-undef */
(function (globalScope) {
  const ext = typeof browser !== 'undefined' ? browser : chrome;

  /**
   * The permanent root folders ("Bookmarks bar", "Other bookmarks", …) have
   * different native ids in every browser and cannot be created, renamed, moved
   * or deleted. Giving them well-known ids keyed by their position under the
   * root lets Chrome and Firefox agree on where a node belongs, instead of each
   * profile minting a random UUID for its own roots — which made every sync
   * re-create the other browser's roots as ordinary nested folders.
   */
  const ROOT_UUID_PREFIX = 'mysync-root-';

  function rootUUID(index) {
    return `${ROOT_UUID_PREFIX}${index}`;
  }

  function isRootUUID(id) {
    return typeof id === 'string' && id.startsWith(ROOT_UUID_PREFIX);
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
    }

    hasBookmarksAPI() {
      return !!(this.ext && this.ext.bookmarks && typeof this.ext.bookmarks.getTree === 'function');
    }

    async initialize() {
      if (!this.hasBookmarksAPI()) {
        return;
      }
      await this.setupAlarm();
      this.attachListeners();
    }

    async setupAlarm() {
      try {
        await this.ext.alarms.clear('bookmarkSync');
        const c = await this.storage.getConfig();
        if (c.bookmarkSyncEnabled === false) {
          return;
        }
        this.ext.alarms.create('bookmarkSync', { delayInMinutes: 2, periodInMinutes: 15 });
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
      }, 4000);
    }

    async markDirtyAndSync() {
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
        if (st.localDirty) {
          await this.push();
        }
      }
      if (c.bookmarkSyncDirection === 'download_only' || c.bookmarkSyncDirection === 'bidirectional') {
        if (c.bookmarkSyncDirection === 'download_only' || !(await this.storage.getBookmarkSyncState()).localDirty) {
          await this.pull();
        }
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

    async push() {
      if (!this.hasBookmarksAPI() || !this.api.isConfigured()) {
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

    async _doPush() {
      const { nodes } = await this.buildNodesForServer();
      const st = await this.storage.getBookmarkSyncState();
      const body = {
        base_version: st.lastServerVersion != null ? st.lastServerVersion : 0,
        nodes
      };
      let res;
      try {
        res = await this.api.putBookmarks(body);
      } catch (e) {
        if (e && e.name === 'APIError' && e.statusCode === 409 && e.body) {
          res = await this._handle409(e.body, body);
          if (res == null) {
            return;
          }
        } else {
          await this.storage.setBookmarkSyncState({ lastError: (e && e.message) || 'push_failed' });
          throw e;
        }
      }
      const v = parseVersion(res);
      await this.storage.setBookmarkSyncState({
        lastServerVersion: v,
        localDirty: false,
        lastSyncedAt: Date.now(),
        lastError: null,
        pendingConflict: null
      });
    }

    /**
     * @returns {Promise<object|null>} response body or null (handled or prompt)
     */
    async _handle409(conflict, body) {
      const cfg = await this.storage.getConfig();
      const act = cfg.bookmarkConflictAction || 'prompt';
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
        return await this.api.putBookmarks(next);
      }
      await this.storage.setBookmarkSyncState({
        pendingConflict: { ...conflict, overwritesServer: autoLocal },
        lastError: autoLocal ? 'local_wins_needs_ack' : 'version_conflict'
      });
      return null;
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
        return;
      }
      if (st.localDirty) {
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
        const uuid = rootUUID(i);
        protectedIds.add(nid);
        const stale = nativeToUUID[nid];
        if (stale && stale !== uuid) {
          delete uuidToNative[stale];
        }
        nativeToUUID[nid] = uuid;
        uuidToNative[uuid] = nid;
      }
      return protectedIds;
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
        await this.storage.setBookmarkSyncState({ lastServerVersion: version, lastSyncedAt: Date.now() });
        return;
      }

      const maps = await this.storage.getBookmarkIdMaps();
      const uuidToNative = { ...(maps.uuidToNative || {}) };
      const nativeToUUID = { ...(maps.nativeToUUID || {}) };

      const protectedIds = await this._seedRootMappings(nativeToUUID, uuidToNative);
      const topParentId = await this.getDefaultParentId();
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
        const parentIdForCreate = n.parentId && uuidToNative[n.parentId] ? String(uuidToNative[n.parentId]) : topParentId;

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
          for (const u of mapped) {
            if (serverSet.has(u)) {
              continue;
            }
            const nid = uuidToNative[u];
            if (nid && !protectedIds.has(String(nid))) {
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

      for (const u of Object.keys(uuidToNative)) {
        const nid = uuidToNative[u];
        if (nid) {
          nativeToUUID[nid] = u;
        }
      }

      await this.storage.setBookmarkIdMaps({ nativeToUUID, uuidToNative });
      await this.storage.setBookmarkSyncState({ lastServerVersion: version, lastSyncedAt: Date.now(), lastError: null, localDirty: false });
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
        await this.storage.setBookmarkSyncState({ pendingConflict: null, lastError: null });
        return { ok: true };
      }
      if (choice === 'use_local' || choice === 'local') {
        // Choosing this at the prompt is the acknowledgement that unblocks the
        // automatic local_wins path for later conflicts.
        await this.storage.setConfig({ bookmarkLocalWinsAcknowledged: true });
        const { nodes } = await this.buildNodesForServer();
        const sv = p.serverVersion != null ? p.serverVersion : p.server_version;
        const body = { base_version: sv, nodes };
        const res = await this.api.putBookmarks(body);
        const v = parseVersion(res);
        await this.storage.setBookmarkSyncState({
          lastServerVersion: v,
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
})(typeof self !== 'undefined' ? self : window);
