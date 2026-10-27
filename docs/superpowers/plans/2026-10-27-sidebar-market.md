# Sidebar market migration

Goal: move the existing plugin market from Settings into the DSH left sidebar.

Use the host's sidebar.panellist entry (id dsh-plugin-market, label 插件市场,
order 25) and main view (key dsh-plugin-market). The sidebar slot renders a
small currentColor SVG icon. The main view supplies a native-looking heading
and its own scroll container around the existing three-tab market. Remove the
settings.section registration. Keep the HTTP APIs and market behavior intact.

- [x] Update the client registration tests to require the sidebar/main pair and no Settings entry; confirm failure.
- [x] Implement the native registration and full-height, responsive page shell.
- [x] Update README, package description, doc checks and screenshots to match navigation.
- [x] Run focused and full checks; install the changed client into the desktop profile.
- [x] Verify the left-sidebar entry, selection, scrolling, tabs, search and absent Settings entry in the live desktop.

Validation: all 12 check stages passed. The UI detector returned no findings.
Desktop 0.2.1-rc.3 displayed one sidebar entry and one main market page, with no
market entry in Settings. Independent page scrolling and a 900px viewport had
no horizontal overflow. Live tab, search, draft-safe pagination, clear-filter,
and force-refresh checks passed. Updated both declared screenshots from the
actual desktop. Previous installed plugin files are backed up outside the repo.

Existing working changes must be retained. The subsequent integration request
authorizes combining these changes with the 1.2.0 fixes and pushing main to
the plugin repository. Catalog synchronization is outside this request.
