// src/App.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import 'shaka-player/dist/controls.css';
import './App.css';

const shaka = require('shaka-player/dist/shaka-player.ui.js');

function App() {
  const [hlsUrl, setHlsUrl] = useState('https://storage.googleapis.com/hls-streaming-bucket/hls/astylhiwaoefjraf/d9343f94728b437eb5fa91b5b0368304-master.m3u8'); // Pre-fill for testing
  const [manifestUrlToLoad, setManifestUrlToLoad] = useState('');
  const [programs, setPrograms] = useState([]);
  const [selectedProgramLabel, setSelectedProgramLabel] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false); // New state for managing switch operations
  const [error, setError] = useState(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerLogs, setPlayerLogs] = useState([]); // For displaying logs in UI

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const uiRef = useRef(null);

  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [
        `[${new Date().toLocaleTimeString()}] ${message}`,
        ...prevLogs.slice(0, 19) // Keep last 20 logs
    ]);
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

      const ui = new shaka.ui.Overlay(player, videoContainerRef.current, videoRef.current);
      uiRef.current = ui;
      ui.getControls(); // Build default UI
      addLog('Shaka UI Overlay initialized.');

      player.addEventListener('error', (event) => {
        const errorDetail = event.detail;
        addLog(`PLAYER ERROR: Code: ${errorDetail.code}, Message: ${errorDetail.message}, Data: ${JSON.stringify(errorDetail.data)}`);
        setError(`Player Error: ${errorDetail.message} (Code: ${errorDetail.code})`);
        setIsLoading(false);
        setIsSwitching(false);
      });

      player.addEventListener('variantchanged', () => {
        const newVariant = player.getVariantTracks().find(v => v.active);
        if (newVariant) {
          addLog(`EVENT: variantchanged. New active variant - ID: ${newVariant.id}, Label: "${newVariant.label}", Bandwidth: ${newVariant.bandwidth}`);
        } else {
          addLog('EVENT: variantchanged. No active variant found (should not happen if playing).');
        }
        setIsSwitching(false); // A variant change likely means a switch attempt completed
      });

      player.addEventListener('trackschanged', () => {
        addLog('EVENT: trackschanged. The set of available tracks has changed.');
      });

      player.addEventListener('buffering', (event) => {
        addLog(`EVENT: buffering. Player buffering state: ${event.buffering}`);
      });
      
      player.addEventListener('loading', () => {
        addLog('EVENT: loading. Player has started loading data.');
      });

      setIsPlayerReady(true);
      addLog('Shaka Player is ready.');
    }

    return () => {
      addLog('App component unmounting. Destroying Shaka Player...');
      if (playerRef.current) {
        playerRef.current.destroy().then(() => {
            addLog('Player destroyed successfully.');
        }).catch((e) => {
            addLog(`Error destroying player: ${e}`);
        });
        playerRef.current = null;
      }
      if (uiRef.current) {
        // uiRef.current.destroy(); // Shaka UI is often destroyed with player
        uiRef.current = null;
      }
      addLog('Cleanup complete.');
    };
  }, [addLog]); // addLog is memoized

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

      try {
        await playerRef.current.load(manifestUrlToLoad);
        addLog('Manifest loaded successfully by player!');

        const variantTracks = playerRef.current.getVariantTracks();
        addLog(`Found ${variantTracks.length} variant tracks.`);
        // variantTracks.forEach(v => addLog(`  Track ID: ${v.id}, Label: "${v.label}", Active: ${v.active}, Video: ${v.video?.label}, Audio: ${v.audio?.label}`));

        const programMap = new Map();
        variantTracks.forEach(variant => {
          let programName = variant.label ||
                            (variant.video && variant.video.label) ||
                            `Program (VID: ${variant.video?.id}, AID: ${variant.audio?.id})`;
          if (!programMap.has(programName)) {
            programMap.set(programName, variant);
          }
        });

        const availablePrograms = Array.from(programMap.entries()).map(([label, variant]) => ({
          label: label,
          representativeVariantId: variant.id, // Store ID for safer lookup later
          bandwidth: variant.bandwidth // For display
        }));
        
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
          addLog("No distinct programs/layouts found in the manifest.");
          setError("No distinct programs/layouts found.");
        }

      } catch (e) {
        addLog(`ERROR loading manifest or processing tracks: ${e.message || e}`);
        setError(`Error: ${e.message || 'Failed to load or process manifest.'}`);
      } finally {
        setIsLoading(false);
      }
    };

    loadManifest();
  }, [manifestUrlToLoad, isPlayerReady, addLog]);

  // Effect to switch variant track
  useEffect(() => {
    if (!selectedProgramLabel || !playerRef.current || programs.length === 0 || !isPlayerReady || isSwitching) {
      return;
    }

    const programData = programs.find(p => p.label === selectedProgramLabel);
    if (!programData || !programData.representativeVariantId) {
      addLog(`Warning: No program data or representativeVariantId for "${selectedProgramLabel}"`);
      return;
    }

    const targetVariantId = programData.representativeVariantId;
    const allCurrentVariants = playerRef.current.getVariantTracks();
    const activeVariant = allCurrentVariants.find(v => v.active);

    if (activeVariant && activeVariant.id === targetVariantId) {
      addLog(`Program "${selectedProgramLabel}" (Variant ID: ${targetVariantId}) is already active. No switch needed.`);
      return;
    }
    
    const variantToSelect = allCurrentVariants.find(v => v.id === targetVariantId);

    if (variantToSelect) {
      addLog(`Attempting to switch to program: "${selectedProgramLabel}", Variant ID: ${variantToSelect.id}`);
      setIsSwitching(true); // Prevent re-entry and UI spam
      setError(null);

      try {
        // Log player state *before* switch
        const me = playerRef.current.getMediaElement();
        if (me) {
            addLog(`Player state before switch: Paused=${me.paused}, ReadyState=${me.readyState}, NetworkState=${me.networkState}, Buffered=${me.buffered.length ? me.buffered.end(me.buffered.length-1) : 'empty'}`);
        }
        
        playerRef.current.selectVariantTrack(variantToSelect, true /* clearBuffer */);
        addLog(`Call to selectVariantTrack for "${selectedProgramLabel}" (ID: ${variantToSelect.id}) initiated.`);
        // The 'variantchanged' event will confirm the switch and reset isSwitching.
        // If 'variantchanged' doesn't fire, we might need a timeout to reset isSwitching as a fallback.
        setTimeout(() => {
            if (isSwitching) { // If still switching after timeout, something might be stuck
                addLog("Switch timeout reached, resetting isSwitching flag. 'variantchanged' might not have fired.");
                setIsSwitching(false);
            }
        }, 5000); // 5 second timeout for the switch

      } catch (e) {
        addLog(`ERROR calling selectVariantTrack: ${e.message || e}`);
        setError(`Error switching layout: ${e.message}`);
        setIsSwitching(false);
      }
    } else {
      addLog(`ERROR: Could not find variant with ID ${targetVariantId} in current player tracks. Manifest might be outdated or an error occurred.`);
      setError("Failed to find the variant to switch to. Try reloading the stream.");
      setIsSwitching(false);
    }
  }, [selectedProgramLabel, programs, isPlayerReady, addLog, isSwitching]); // isSwitching dependency added to prevent re-runs while one is in progress

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
    if (!isSwitching) { // Only allow change if not currently switching
        addLog(`User selected program: "${event.target.value}"`);
        setSelectedProgramLabel(event.target.value);
    } else {
        addLog(`User tried to select "${event.target.value}" but a switch is already in progress.`);
    }
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
            {isLoading ? 'Loading...' : (isPlayerReady ? 'Load Stream' : 'Player Init...')}
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
            <label htmlFor="program-select">Select Program/Layout: </label>
            <select
              id="program-select"
              value={selectedProgramLabel}
              onChange={handleProgramChange}
              disabled={isLoading || isSwitching}
            >
              {programs.map((program) => (
                <option key={program.label} value={program.label}>
                  {program.label} ({(program.bandwidth / 1000000).toFixed(2)} Mbps)
                </option>
              ))}
            </select>
          </div>
        )}
        {manifestUrlToLoad && programs.length === 0 && !isLoading && !error && (
            <p>No distinct programs found, or stream not loaded.</p>
        )}

        <div className="logs-area">
            <h3>Player Logs:</h3>
            <pre>
                {playerLogs.join('\n')}
            </pre>
        </div>
      </main>
    </div>
  );
}

export default App;