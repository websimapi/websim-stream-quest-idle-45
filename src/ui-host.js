// Host-only UI logic split out of UIManager

import { replaceAllPlayers } from './db.js';

export function setupHostUI(uiManager) {
    const {
        network,
        hostUserMenu,
        hostUserBtn,
        hostUserDropdown,
        realtimeUsersList,
        twitchUsersList,
        exportDataBtn,
        importDataBtn,
        importDataInput
    } = uiManager;

    // Show host user menu
    if (hostUserMenu) {
        hostUserMenu.style.display = 'flex';
    }

    // Host console <-> chat view toggle
    const hostConsole = uiManager.hostConsoleContainer;
    const toggleBtn = document.getElementById('host-console-toggle');
    if (hostConsole && toggleBtn) {
        toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const isChat = hostConsole.classList.toggle('chat-view');
            toggleBtn.textContent = isChat ? 'Chat' : 'Host Console';
        });
    }

    // Streamer Mode toggle button (host only)
    const streamerToggleBtn = document.getElementById('host-streamer-toggle');
    if (streamerToggleBtn) {
        streamerToggleBtn.style.display = 'inline-block';

        const updateStreamerToggleLabel = () => {
            streamerToggleBtn.textContent = uiManager.streamerMode ? 'Streamer: On' : 'Streamer: Off';
            streamerToggleBtn.classList.toggle('active', !!uiManager.streamerMode);
        };

        const disableStreamerMode = () => {
            uiManager.streamerMode = false;
            uiManager.streamerCurrentTwitchId = null;
            uiManager.streamerLastRotateAt = 0;
            uiManager.streamerLastTaskSignatureByPlayer = {};
            updateStreamerToggleLabel();
            // When leaving streamer mode, stop spectating and return to own profile (if any)
            uiManager.stopSpectating();
        };

        const enableStreamerMode = () => {
            uiManager.streamerMode = true;
            uiManager.streamerLastRotateAt = Date.now();
            updateStreamerToggleLabel();
            // Immediately jump to an appropriate starting viewer
            selectNextStreamerTarget(uiManager, network, { preferDifferent: false, allowRandom: true });
        };

        streamerToggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (uiManager.streamerMode) {
                disableStreamerMode();
            } else {
                enableStreamerMode();
            }
        });

        // Expose helpers so other host UI logic can drive streamer mode
        uiManager._updateStreamerToggleLabel = updateStreamerToggleLabel;
        uiManager.disableStreamerMode = disableStreamerMode;
        uiManager.enableStreamerMode = enableStreamerMode;
    }

    // New: Listen for global database saves to update UI if spectating
    window.addEventListener('sq:player_update', (e) => {
        const p = e.detail;
        if (uiManager.spectatingId === p.twitchId) {
             // When first switching to a user, suppress the initial backlog of rewards,
             // then show incremental rewards for subsequent updates.
             const suppressRewards = !uiManager.spectateFirstUpdateSeen;
             uiManager.spectateFirstUpdateSeen = true;
             uiManager.updateState(p, { suppressRewards });
        }

        // Streamer mode: track task signatures and react to actions
        if (uiManager.isHost && uiManager.streamerMode && p && p.twitchId) {
            const prevSig = uiManager.streamerLastTaskSignatureByPlayer[p.twitchId] || '';
            const taskId = p.activeTask ? p.activeTask.taskId || '' : '';
            const startTime = p.activeTask ? p.activeTask.startTime || 0 : 0;
            const newSig = `${taskId}|${startTime}`;

            uiManager.streamerLastTaskSignatureByPlayer[p.twitchId] = newSig;

            const hasEnergy = getPlayerEnergyCount(p) > 0;

            // If current viewer just ran out of energy, immediately rotate
            if (uiManager.spectatingId === p.twitchId && !hasEnergy) {
                selectNextStreamerTarget(uiManager, network, { preferDifferent: true, allowRandom: true });
                return;
            }

            // Detect task completion / new action for the currently viewed player
            if (uiManager.spectatingId === p.twitchId && prevSig && prevSig !== newSig) {
                // Completed one action; move on to another active viewer
                selectNextStreamerTarget(uiManager, network, { preferDifferent: true, allowRandom: true });
                return;
            }

            // If some other player just started a task (no task before, task now) and has energy,
            // treat them as "most recent" and jump to them.
            const prevTaskId = prevSig.split('|')[0] || '';
            if (p.twitchId !== uiManager.spectatingId && !prevTaskId && taskId && hasEnergy) {
                uiManager.streamerCurrentTwitchId = p.twitchId;
                uiManager.streamerLastRotateAt = Date.now();
                if (typeof uiManager.showPlayerProfile === 'function') {
                    uiManager.showPlayerProfile(p);
                }
            }
        }
    });

    // Helper: when a host clicks a user, show their profile (skills/inventory) in the main UI
    const onViewPlayer = (player) => {
        if (!player) return;
        if (typeof uiManager.showPlayerProfile === 'function') {
            uiManager.showPlayerProfile(player);
        }
    };
    
    // Attach a refresher to uiManager so we can update the dropdown content dynamically
    uiManager.refreshHostUserMenu = () => {
        // If spectating, add a "Return to My Profile" button at the top
        const existingReturnBtn = hostUserDropdown.querySelector('#host-return-btn-container');
        if (uiManager.spectatingId) {
            if (!existingReturnBtn) {
                const container = document.createElement('div');
                container.id = 'host-return-btn-container';
                container.className = 'dropdown-section';
                container.innerHTML = `
                    <button class="primary-btn small-primary-btn" style="width:100%; font-size:0.8rem;">
                        Return to My Profile
                    </button>
                `;
                container.querySelector('button').onclick = () => {
                    uiManager.stopSpectating();
                };
                hostUserDropdown.insertBefore(container, hostUserDropdown.firstChild);
            }
        } else {
            if (existingReturnBtn) {
                existingReturnBtn.remove();
            }
        }
    };

    // Host dropdown interactions
    if (hostUserBtn && hostUserDropdown) {
        hostUserBtn.addEventListener('click', () => {
            const isOpen = hostUserDropdown.style.display === 'block';
            hostUserDropdown.style.display = isOpen ? 'none' : 'block';
            if (!isOpen) {
                uiManager.refreshHostUserMenu();
                // Force a refresh when opening the menu to ensure it's up to date
                network.refreshPlayerList();
            }
        });

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            if (!hostUserMenu) return;
            if (!hostUserMenu.contains(e.target)) {
                hostUserDropdown.style.display = 'none';
            }
        });
    }

    // Host export/import data controls
    if (exportDataBtn) {
        exportDataBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            try {
                const exportPayload = await network.exportChannelData();
                const blob = new Blob([JSON.stringify(exportPayload, null, 2)], {
                    type: 'application/json'
                });

                const url = URL.createObjectURL(blob);
                const a = document.createElement('a');
                const channel = exportPayload?.channel || localStorage.getItem('sq_host_channel') || 'channel';
                const date = new Date().toISOString().replace(/[:.]/g, '-');
                a.href = url;
                a.download = `streamquest_${channel}_players_${date}.json`;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                URL.revokeObjectURL(url);
            } catch (err) {
                console.error('Export failed', err);
            }
        });
    }

    if (importDataBtn && importDataInput) {
        importDataBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            importDataInput.click();
        });

        importDataInput.addEventListener('change', async (e) => {
            e.stopPropagation();
            const file = e.target.files && e.target.files[0];
            if (!file) return;

            const confirmOverride = window.confirm(
                'Importing will OVERWRITE all existing player data for this channel. Continue?'
            );
            if (!confirmOverride) {
                importDataInput.value = '';
                return;
            }

            try {
                const text = await file.text();
                const parsed = JSON.parse(text);

                let players = [];
                let importChannel = null;

                if (Array.isArray(parsed)) {
                    // Legacy format: plain array of players
                    players = parsed;
                } else if (parsed && Array.isArray(parsed.players)) {
                    // New format: { channel, players: [...] }
                    players = parsed.players;
                    importChannel = parsed.channel || null;
                } else {
                    alert('Invalid import file: expected an array of players or an object with { channel, players }.');
                    importDataInput.value = '';
                    return;
                }

                await network.importChannelData({ players, channel: importChannel }, replaceAllPlayers);
                alert('Import complete. Player data has been replaced for this channel.');
            } catch (err) {
                console.error('Import failed', err);
                alert('Import failed. Check the console for details.');
            } finally {
                importDataInput.value = '';
            }
        });
    }

    // Track latest players list on the network manager so we can correlate peers <-> players
    network.lastPlayers = network.lastPlayers || [];

    // Hook host-specific callbacks
    network.onPresenceUpdate = (peers) => {
        // Re-render realtime users whenever presence changes, using the last known players list
        renderRealtimeUsers(peers, realtimeUsersList, onViewPlayer, network.lastPlayers);
    };

    network.onPlayerListUpdate = (players, peers) => {
        // Cache players for use in presence updates and realtime/twitch rendering
        network.lastPlayers = Array.isArray(players) ? players : [];

        renderTwitchUsers(players, peers, twitchUsersList, onViewPlayer);
        renderRealtimeUsers(
            Object.entries(peers || {}).map(([id, info]) => ({
                id,
                username: info.username
            })),
            realtimeUsersList,
            onViewPlayer,
            network.lastPlayers
        );
    };

    // Periodic Streamer Mode driver (host only)
    if (uiManager.isHost && !uiManager.streamerInterval) {
        uiManager.streamerInterval = setInterval(() => {
            if (!uiManager.streamerMode) return;

            const players = Array.isArray(network.lastPlayers) ? network.lastPlayers : [];
            const candidates = players.filter((p) => getPlayerEnergyCount(p) > 0);

            // If no one has any energy, show no user until someone has energy
            if (!candidates.length) {
                if (uiManager.spectatingId) {
                    uiManager.streamerCurrentTwitchId = null;
                    uiManager.streamerLastRotateAt = Date.now();
                    uiManager.stopSpectating();
                }
                return;
            }

            // If someone has an active task, we rely on sq:player_update to jump to them.
            const anyActiveTask = candidates.some((p) => p.activeTask && p.activeTask.taskId);
            if (anyActiveTask) {
                return;
            }

            // No recent user actions (no active tasks): after 25s, auto-switch to a random active user.
            const now = Date.now();
            const elapsed = now - (uiManager.streamerLastRotateAt || 0);
            if (elapsed >= 25000) {
                selectNextStreamerTarget(uiManager, network, { preferDifferent: true, allowRandom: true });
            }
        }, 3000);
    }

    // Trigger Initial Updates immediately to sync with existing network state
    // 1. Populate presence if already available on the room
    if (network.room && network.room.peers) {
        const initialPeers = Object.entries(network.room.peers).map(([id, info]) => ({
            id,
            username: info.username
        }));
        // Fire manual presence update to render lists immediately
        if (network.onPresenceUpdate) {
            network.onPresenceUpdate(initialPeers);
        }
    }

    // 2. Trigger player list refresh.
    // We use the promise approach if initialization is pending, but ALSO try immediately
    // to catch cases where initialization was fast or synchronous.
    if (typeof network.refreshPlayerList === 'function') {
        // Immediate attempt
        network.refreshPlayerList();

        // Promise-based attempt (for post-init refresh)
        if (network.ready && typeof network.ready.then === 'function') {
            network.ready.then(() => {
                network.refreshPlayerList();
            });
        }
    }
}

// Helper: compute available energy for a player (mirrors server-side getAvailableEnergyCount)
function getPlayerEnergyCount(player) {
    if (!player) return 0;
    const now = Date.now();
    let active = 0;

    if (player.activeEnergy) {
        if (typeof player.activeEnergy.consumedMs === 'number') {
            if (player.activeEnergy.consumedMs < 60 * 60 * 1000) {
                active = 1;
            }
        } else if (player.activeEnergy.startTime) {
            if (now - (player.activeEnergy.startTime || 0) < 60 * 60 * 1000) {
                active = 1;
            }
        }
    }

    const stored = Array.isArray(player.energy) ? player.energy.length : 0;
    return stored + active;
}

// Helper: choose next viewer in streamer mode
function selectNextStreamerTarget(uiManager, network, { preferDifferent, allowRandom }) {
    const players = Array.isArray(network.lastPlayers) ? network.lastPlayers : [];
    const candidates = players.filter((p) => getPlayerEnergyCount(p) > 0);

    if (!candidates.length) {
        uiManager.streamerCurrentTwitchId = null;
        uiManager.streamerLastRotateAt = Date.now();
        uiManager.stopSpectating();
        return;
    }

    const currentId = uiManager.spectatingId || uiManager.streamerCurrentTwitchId;

    // Prefer users with active tasks (most recent actions), ordered by latest startTime
    const active = candidates
        .filter((p) => p.activeTask && p.activeTask.taskId)
        .sort(
            (a, b) =>
                (b.activeTask.startTime || 0) -
                (a.activeTask.startTime || 0)
        );

    let target = null;

    const pickFromList = (list) => {
        if (!list.length) return null;
        if (preferDifferent && list.length > 1) {
            const different = list.find((p) => p.twitchId !== currentId);
            return different || list[0];
        }
        return list[0];
    };

    target = pickFromList(active);

    // If no active tasks, optionally pick a random candidate
    if (!target && allowRandom) {
        const pool = preferDifferent
            ? candidates.filter((p) => p.twitchId !== currentId)
            : candidates.slice();
        if (pool.length) {
            target = pool[Math.floor(Math.random() * pool.length)];
        }
    }

    if (!target) {
        // Fallback: just keep current view
        return;
    }

    uiManager.streamerCurrentTwitchId = target.twitchId;
    uiManager.streamerLastRotateAt = Date.now();

    if (typeof uiManager.showPlayerProfile === 'function') {
        uiManager.showPlayerProfile(target);
    }
}

export function renderRealtimeUsers(peers, listEl, onViewPlayer, players) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const allPlayers = Array.isArray(players) ? players : [];

    peers.forEach(peer => {
        const li = document.createElement('li');

        // Find if this realtime WebSim user is linked to a Twitch player profile
        const linkedPlayer = allPlayers.find(p => p.linkedWebsimId === peer.id);

        if (linkedPlayer) {
            // Linked realtime user: show "WebSim ↔ Twitch" and make clickable
            li.classList.add('linked-profile', 'clickable');
            li.innerHTML = `
                <span class="user-name">${peer.username}</span>
                <span class="user-meta">(linked ↔ ${linkedPlayer.username})</span>
            `;
            if (typeof onViewPlayer === 'function') {
                li.addEventListener('click', () => onViewPlayer(linkedPlayer));
            }
        } else {
            // Unlinked realtime user: WebSim username only, grey, not clickable (no profile)
            li.classList.add('unlinked-no-profile');
            li.innerHTML = `
                <span class="user-name">${peer.username}</span>
                <span class="user-meta">(no profile)</span>
            `;
        }

        listEl.appendChild(li);
    });
}

export function renderTwitchUsers(players, peers, listEl, onViewPlayer) {
    if (!listEl) return;
    listEl.innerHTML = '';
    const peersMap = peers || {};

    (players || []).forEach(player => {
        const li = document.createElement('li');
        const isLinked = !!player.linkedWebsimId && !!peersMap[player.linkedWebsimId];

        li.classList.add('twitch-user-item', 'clickable');

        let linkedLabel = '';
        if (isLinked) {
            const peerInfo = peersMap[player.linkedWebsimId];
            const websimName = peerInfo?.username || player.linkedWebsimId;
            linkedLabel = `(linked ↔ ${websimName})`;
        } else {
            // Unlinked Twitch users still have a profile and are playing
            linkedLabel = '(unlinked)';
        }

        li.innerHTML = `
            <span class="user-name">${player.username}</span>
            <span class="user-meta">${linkedLabel}</span>
        `;

        if (typeof onViewPlayer === 'function') {
            li.addEventListener('click', () => onViewPlayer(player));
        }

        listEl.appendChild(li);
    });
}