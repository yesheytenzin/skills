---
name: omarchy-maintenance
description: >-
  Safe system maintenance workflows for Omarchy / Arch Linux: running
  omarchy-update, creating Timeshift/snapper snapshots before risky changes,
  cleaning orphaned packages and pacman cache, checking disk space and failed
  systemd services, and rolling back a bad update. Use when the user asks to
  update the system, clean up packages or disk space, fix a broken update,
  maintain Arch/Omarchy, or before making system-level changes.
---

# Omarchy System Maintenance

Companion skills: `omarchy` (desktop customization), `diagnose-crash` (core dumps).

## Golden rules

1. **Snapshot before system-level changes** (package removals, major updates, config overhauls). Check what's available and use it:
   ```bash
   timeshift --list 2>/dev/null || snapper list 2>/dev/null || echo "no snapshot tool configured"
   ```
   If no snapshot tool exists, warn the user and ask whether to proceed without one.
2. **Never force-remove** packages (`-Rdd`, `-Rdds`) without explicit user confirmation — it breaks dependency graphs.
3. **Read before removing**: `pacman -Qdt` output can include packages something still needs; verify with `pactree -r <pkg>` when unsure.
4. Partial upgrades are forbidden on Arch: always full `-Syu`, never `-Sy <pkg>` alone.

## Update workflow

```bash
# 1. Check news for breakage first (Arch manual intervention notices)
omarchy-update --help 2>/dev/null   # see available flags
# Or manually:
checkupdates 2>/dev/null | head -30

# 2. Snapshot (if tool exists), then update
timeshift --create --comments "before update $(date +%F)" 2>/dev/null

# 3. Run the official updater
omarchy-update
```

If `omarchy-update` fails mid-run:
1. Read the actual error; do not retry blindly.
2. Keyring errors → `sudo pacman -Sy archlinux-keyring && sudo pacman -Su`.
3. File conflicts → inspect with `pacman -Qo /path/to/file` before any `--overwrite`.

## Cleanup workflow

Run diagnostics first, present findings, then act:

```bash
df -h /                                          # disk pressure?
pacman -Qdt                                      # orphaned packages
pacman -Qtdq | wc -l                             # orphan count
du -sh /var/cache/pacman/pkg/                    # package cache size
journalctl --disk-usage                          # journal size
systemctl --failed                               # broken services
```

Safe cleanups (in order of safety):
```bash
sudo pacman -Rns $(pacman -Qtdq)                 # remove orphans (confirm list first!)
sudo pacman -Sc                                  # prune old package cache versions
sudo journalctl --vacuum-time=2weeks             # trim journals
```

Ask before: `pacman -Scc` (wipes entire cache — kills rollback ability), removing AUR helpers' caches, or deleting anything in `/home`.

## Health check

```bash
systemctl --failed
journalctl -p err -b --no-pager | tail -20       # this boot's errors
sudo dmesg --level=err,warn | tail -20
```

## Rollback

- Bad update: `timeshift --restore` (or `snapper rollback`), or downgrade single packages from cache:
  ```bash
  ls /var/cache/pacman/pkg/<pkg>-*.pkg.tar.zst
  sudo pacman -U /var/cache/pacman/pkg/<old-version>.pkg.tar.zst
  ```
- No cached version: fetch from Arch Archive — `https://archlinux.org/packages/<pkg>/` shows history; add `[options] IgnorePkg = <pkg>` to `/etc/pacman.conf` until fixed.
- Broken Hyprland/session after update: try switching to a TTY (Ctrl+Alt+F3) before assuming the system is dead.

## Presenting results

Report as: **what was found → what was done → what needs user decision**. Never chain destructive steps silently.
