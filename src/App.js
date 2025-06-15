// src/App.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import 'shaka-player/dist/controls.css';
import './App.css';

const shaka = require('shaka-player/dist/shaka-player.ui.js');

function App() {
  const [hlsUrl, setHlsUrl] = useState('https://storage.googleapis.com/hls-streaming-bucket/hls/astylhiwaoefjraf/d9343f94728b437eb5fa91b5b0368304-master.m3u8');
  const [manifestUrlToLoad, setManifestUrlToLoad] = useState('');
  const [programs, setPrograms] = useState([]);
  const [selectedProgramLabel, setSelectedProgramLabel] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerLogs, setPlayerLogs] = useState([]);
  const [abrEnabled, setAbrEnabled] = useState(false); // ABR disabled by default for manual switching

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const uiRef = useRef(null);
  const switchTimeoutRef = useRef(null);
  const manifestVersionRef = useRef(0); // Track manifest changes

  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [
        `[${new Date().toLocaleTimeString()}] ${message}`,
        ...prevLogs.slice(0, 19)
    ]);
  }, []);

  // Clear any existing switch timeout
  const clearSwitchTimeout = useCallback(() => {
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current);
      switchTimeoutRef.current = null;
    }
  }, []);

  // Initialize Shaka Player
  useEffect(() => {
    addLog('App component mounted. Initializing Shaka Player...');
    shaka.polyfill.installAll();

    if (!shaka.Player.isBrowserSupported()) {
      const msg = 'Browser not supported by Shaka Player.';
      addLog(`ERROR: ${msg}`);
      setError(msg);
      return;
    }

    if (videoRef.current && videoContainerRef.current) {
      const player = new shaka.Player(videoRef.current);
      playerRef.current = player;
      addLog('Shaka Player instance created.');

      // Configure ABR settings
      player.configure({
        abr: {
          enabled: abrEnabled
        }
      });
      addLog(`ABR manager ${abrEnabled ? 'enabled' : 'disabled'}`);

      const ui = new shaka.ui.Overlay(player, videoContainerRef.current, videoRef.current);
      uiRef.current = ui;
      ui.getControls();
      addLog('Shaka UI Overlay initialized.');

      player.addEventListener('error', (event) => {
        const errorDetail = event.detail;
        addLog(`PLAYER ERROR: Code: ${errorDetail.code}, Message: ${errorDetail.message}`);
        setError(`Player Error: ${errorDetail.message} (Code: ${errorDetail.code})`);
        setIsLoading(false);
        setIsSwitching(false);
        clearSwitchTimeout();
      });

      player.addEventListener('variantchanged', () => {
        const newVariant = player.getVariantTracks().find(v => v.active);
        if (newVariant) {
          addLog(`EVENT: variantchanged. New active variant - ID: ${newVariant.id}, Label: "${newVariant.label}"`);
        }
        setIsSwitching(false);
        clearSwitchTimeout();
        
        // Re-enable ABR after successful switch (only if it was originally enabled)
        if (playerRef.current && abrEnabled) {
          addLog("Re-enabling ABR manager after variant change");
          playerRef.current.configure({
            abr: {
              enabled: true
            }
          });
        }
      });

      player.addEventListener('trackschanged', () => {
        addLog('EVENT: trackschanged. Available tracks have changed.');
      });

      player.addEventListener('buffering', (event) => {
        addLog(`EVENT: buffering. State: ${event.buffering}`);
      });
      
      player.addEventListener('loading', () => {
        addLog('EVENT: loading. Player loading data.');
      });

      setIsPlayerReady(true);
      addLog('Shaka Player is ready.');
    }

    return () => {
      addLog('App component unmounting. Destroying Shaka Player...');
      clearSwitchTimeout();
      if (playerRef.current) {
        playerRef.current.destroy().then(() => {
            addLog('Player destroyed successfully.');
        }).catch((e) => {
            addLog(`Error destroying player: ${e}`);
        });
        playerRef.current = null;
      }
      if (uiRef.current) {
        uiRef.current = null;
      }
      addLog('Cleanup complete.');
    };
  }, [addLog, clearSwitchTimeout, abrEnabled]); // Added abrEnabled dependency

  function extractProgramNameFromOriginalId(originalVideoId) {
    if (!originalVideoId) return null;
    
    const programWithDimensionsAndTypeMatch = originalVideoId.match(/_([^_]+)_\d+_\d+_(video|audio|av)\.m3u8$/);
    if (programWithDimensionsAndTypeMatch) {
        return programWithDimensionsAndTypeMatch[1];
    }
    
    const programMatch = originalVideoId.match(/_([^_]+)\.m3u8$/);
    if (programMatch) {
        return programMatch[1];
    }
  }
  // Effect to load manifest
  useEffect(() => {
    if (!manifestUrlToLoad || !playerRef.current || !isPlayerReady) {
      return;
    }

    const loadManifest = async () => {
      addLog(`Attempting to load manifest: ${manifestUrlToLoad}`);
      setIsLoading(true);
      setError(null);
      setPrograms([]);
      setSelectedProgramLabel('');
      setIsSwitching(false);
      clearSwitchTimeout();
      
      // Increment manifest version to invalidate old switches
      manifestVersionRef.current += 1;
      const currentManifestVersion = manifestVersionRef.current;

      try {
        await playerRef.current.load(manifestUrlToLoad);
        
        // Check if this is still the current manifest load
        if (currentManifestVersion !== manifestVersionRef.current) {
          addLog('Manifest load cancelled - newer load in progress');
          return;
        }

        addLog('Manifest loaded successfully!');

        const variantTracks = playerRef.current.getVariantTracks();
        addLog(`Found ${variantTracks.length} variant tracks.`);

        const programMap = new Map();
        variantTracks.forEach(variant => {
          let programName = variant.label ||
                 (variant.video && variant.video.label) ||
                 extractProgramNameFromOriginalId(variant.originalVideoId) ||
                 extractProgramNameFromOriginalId(variant.originalAudioId) ||
                 `Program (VID: ${variant.videoId || 'undefined'}, AID: ${variant.audioId || 'undefined'})`;
          addLog(`programName ${programName} in the track ${JSON.stringify(variant)}`);

          if (!programMap.has(programName)) {
            programMap.set(programName, {
              label: programName,
              variantId: variant.id,
              bandwidth: variant.bandwidth,
              manifestVersion: currentManifestVersion // Track which manifest this belongs to
            });
          }
        });

        const availablePrograms = Array.from(programMap.values());
        setPrograms(availablePrograms);
        addLog(`Populated ${availablePrograms.length} distinct programs.`);

        if (availablePrograms.length > 0) {
          const activeVariant = variantTracks.find(v => v.active);
          let initialProgramLabel = availablePrograms[0].label;

          if (activeVariant) {
            let activeProgramName = activeVariant.label ||
                                   (activeVariant.video && activeVariant.video.label) ||
                                   `Program (VID: ${activeVariant.video?.id}, AID: ${activeVariant.audio?.id})`;
            
            const foundProgram = availablePrograms.find(p => p.label === activeProgramName);
            if (foundProgram) initialProgramLabel = foundProgram.label;
          }
          setSelectedProgramLabel(initialProgramLabel);
          addLog(`Initial program set to: "${initialProgramLabel}"`);
        } else {
          addLog("No distinct programs found in the manifest.");
          setError("No distinct programs found.");
        }

      } catch (e) {
        if (currentManifestVersion === manifestVersionRef.current) {
          addLog(`ERROR loading manifest: ${e.message || e}`);
          setError(`Error: ${e.message || 'Failed to load manifest.'}`);
        }
      } finally {
        if (currentManifestVersion === manifestVersionRef.current) {
          setIsLoading(false);
        }
      }
    };

    loadManifest();
  }, [manifestUrlToLoad, isPlayerReady, addLog, clearSwitchTimeout]);

  // Effect to switch variant track
  useEffect(() => {
    if (!selectedProgramLabel || !playerRef.current || programs.length === 0 || !isPlayerReady) {
      return;
    }

    // Prevent multiple concurrent switches
    if (isSwitching) {
      addLog(`Switch already in progress, ignoring request for "${selectedProgramLabel}"`);
      return;
    }

    const programData = programs.find(p => p.label === selectedProgramLabel);
    if (!programData || !programData.variantId) {
      addLog(`Warning: No program data found for "${selectedProgramLabel}"`);
      return;
    }

    // Check if this program data is from the current manifest
    if (programData.manifestVersion !== manifestVersionRef.current) {
      addLog(`Program data is outdated (manifest version mismatch). Skipping switch.`);
      return;
    }

    const targetVariantId = programData.variantId;
    const allCurrentVariants = playerRef.current.getVariantTracks();
    const activeVariant = allCurrentVariants.find(v => v.active);

    if (activeVariant && activeVariant.id === targetVariantId) {
      addLog(`Program "${selectedProgramLabel}" is already active. No switch needed.`);
      return;
    }
    
    const variantToSelect = allCurrentVariants.find(v => v.id === targetVariantId);

    if (!variantToSelect) {
      addLog(`ERROR: Could not find variant with ID ${targetVariantId}. Available IDs: ${allCurrentVariants.map(v => v.id).join(', ')}`);
      setError("Variant not found. The stream may have changed. Try reloading.");
      return;
    }

    addLog(`Switching to program: "${selectedProgramLabel}", Variant ID: ${variantToSelect.id}`);
    setIsSwitching(true);
    setError(null);

    try {
      const me = playerRef.current.getMediaElement();
      if (me) {
          addLog(`Player state before switch: Paused=${me.paused}, ReadyState=${me.readyState}`);
      }
      
      // Disable ABR to prevent automatic variant switching
      addLog("Disabling ABR manager to prevent automatic switching");
      playerRef.current.configure({
        abr: {
          enabled: false
        }
      });
      
      playerRef.current.selectVariantTrack(variantToSelect, true);
      addLog(`selectVariantTrack called for "${selectedProgramLabel}" (ID: ${variantToSelect.id})`);
      
      // Set timeout to reset switching state if variantchanged doesn't fire
      switchTimeoutRef.current = setTimeout(() => {
          addLog("Switch timeout reached. Resetting switching state.");
          setIsSwitching(false);
          switchTimeoutRef.current = null;
      }, 5000);

    } catch (e) {
      addLog(`ERROR calling selectVariantTrack: ${e.message || e}`);
      setError(`Error switching layout: ${e.message}`);
      setIsSwitching(false);
      clearSwitchTimeout();
    }
  }, [selectedProgramLabel, programs, isPlayerReady, addLog, clearSwitchTimeout]); // Removed isSwitching from dependencies

  const handleUrlChange = (event) => setHlsUrl(event.target.value);

  const handleLoadClick = () => {
    if (hlsUrl.trim()) {
      setManifestUrlToLoad(hlsUrl.trim());
    } else {
      setError("Please enter an HLS URL.");
      addLog("Load clicked with empty URL.");
    }
  };

  const handleProgramChange = (event) => {
    const newValue = event.target.value;
    
    if (isSwitching || isLoading) {
        addLog(`User tried to select "${newValue}" but operation in progress. Current switching: ${isSwitching}, loading: ${isLoading}`);
        // Prevent the dropdown from changing by resetting to current value
        setTimeout(() => {
          event.target.value = selectedProgramLabel;
        }, 0);
        return;
    }
    
    addLog(`User selected program: "${newValue}"`);
    setSelectedProgramLabel(newValue);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>HLS Program Selector with Shaka Player</h1>
      </header>
      <main>
        <div className="input-area">
          <input
            type="text"
            value={hlsUrl}
            onChange={handleUrlChange}
            placeholder="Enter HLS Manifest URL (.m3u8)"
            disabled={isLoading || isSwitching}
          />
          <button onClick={handleLoadClick} disabled={isLoading || isSwitching || !isPlayerReady}>
            {isLoading ? 'Loading...' : (isSwitching ? 'Switching...' : (isPlayerReady ? 'Load Stream' : 'Player Init...'))}
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}

        <div ref={videoContainerRef} className="video-container" data-shaka-player-container data-shaka-player-cast-receiver-id="APP_ID">
          <video
            ref={videoRef}
            id="video"
            autoPlay
            controls={false}
            style={{ width: '100%', height: '100%' }}
            data-shaka-player
          ></video>
        </div>

        {programs.length > 0 && (
          <div className="controls-area">
            <div style={{ marginBottom: '10px' }}>
              <label>
                <input
                  type="checkbox"
                  checked={abrEnabled}
                  onChange={(e) => {
                    setAbrEnabled(e.target.checked);
                    if (playerRef.current) {
                      playerRef.current.configure({
                        abr: {
                          enabled: e.target.checked
                        }
                      });
                      addLog(`ABR ${e.target.checked ? 'enabled' : 'disabled'} by user`);
                    }
                  }}
                  disabled={isLoading || isSwitching}
                />
                {' '}Enable Adaptive Bitrate (ABR) - Note: May interfere with manual program switching
              </label>
            </div>
            
            <label htmlFor="program-select">Select Program/Layout: </label>
            <select
              id="program-select"
              value={selectedProgramLabel}
              onChange={handleProgramChange}
              disabled={isLoading || isSwitching}
              style={{ 
                opacity: (isLoading || isSwitching) ? 0.6 : 1,
                cursor: (isLoading || isSwitching) ? 'not-allowed' : 'pointer'
              }}
            >
              {programs.map((program) => (
                <option key={program.label} value={program.label}>
                  {program.label} ({(program.bandwidth / 1000000).toFixed(2)} Mbps)
                </option>
              ))}
            </select>
            {isSwitching && <span className="switching-indicator"> Switching...</span>}
          </div>
        )}
        
        {manifestUrlToLoad && programs.length === 0 && !isLoading && !error && (
            <p>No distinct programs found, or stream not loaded.</p>
        )}

        <div className="logs-area">
            <h3>Player Logs:</h3>
            <pre style={{ maxHeight: '300px', overflow: 'auto', fontSize: '12px' }}>
                {playerLogs.join('\n')}
            </pre>
        </div>
      </main>
    </div>
  );
}

export default App;