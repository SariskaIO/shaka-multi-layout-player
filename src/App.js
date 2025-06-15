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
  const [abrEnabled, setAbrEnabled] = useState(false);
  const [playbackStalled, setPlaybackStalled] = useState(false);
  const [lastPlaybackTime, setLastPlaybackTime] = useState(0);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const uiRef = useRef(null);
  const switchTimeoutRef = useRef(null);
  const manifestVersionRef = useRef(0);
  const stallCheckIntervalRef = useRef(null);
  const lastTimeUpdateRef = useRef(0);
  const stallCountRef = useRef(0);

  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [
        `[${new Date().toLocaleTimeString()}] ${message}`,
        ...prevLogs.slice(0, 19)
    ]);
  }, []);

  const clearSwitchTimeout = useCallback(() => {
    if (switchTimeoutRef.current) {
      clearTimeout(switchTimeoutRef.current);
      switchTimeoutRef.current = null;
    }
  }, []);

  // Conservative player configuration for cache handling
  const getOptimizedPlayerConfig = useCallback(() => {
    return {
      streaming: {
        // Reduced buffering to prevent excessive caching
        bufferingGoal: 15,
        rebufferingGoal: 2,
        bufferBehind: 20,
        
        // Conservative retry parameters
        retryParameters: {
          maxAttempts: 3,
          baseDelay: 1000,
          backoffFactor: 2,
          fuzzFactor: 0.5,
          timeout: 30000,
          stallTimeout: 5000,
          connectionTimeout: 10000
        }
      },
      
      manifest: {
        retryParameters: {
          maxAttempts: 2,
          baseDelay: 1000,
          backoffFactor: 2,
          timeout: 30000
        },
        
        hls: {
          ignoreTextStreamFailures: true,
          useFullSegmentsForStartTime: false
        }
      },
      
      abr: {
        enabled: abrEnabled
      }
    };
  }, [abrEnabled]);

  // Detect and handle playback stalls
  const setupStallDetection = useCallback(() => {
    if (stallCheckIntervalRef.current) {
      clearInterval(stallCheckIntervalRef.current);
    }

    stallCheckIntervalRef.current = setInterval(() => {
      if (!videoRef.current || !playerRef.current) return;

      const video = videoRef.current;
      const currentTime = video.currentTime;
      
      // Check if playback is progressing
      if (!video.paused && currentTime === lastTimeUpdateRef.current) {
        stallCountRef.current += 1;
        
        if (stallCountRef.current >= 3) { // 3 seconds of no progress
          addLog(`Playback stall detected at time ${currentTime}. Attempting recovery...`);
          setPlaybackStalled(true);
          
          // Attempt recovery
          if (playerRef.current.isLive()) {
            // For live streams, seek to live edge
            const seekRange = playerRef.current.seekRange();
            if (seekRange.end > currentTime + 10) {
              addLog(`Seeking to live edge: ${seekRange.end - 2}`);
              video.currentTime = seekRange.end - 2;
            }
          } else {
            // For VOD, try to seek slightly forward
            addLog(`Seeking forward by 0.1 seconds to recover from stall`);
            video.currentTime = currentTime + 0.1;
          }
          
          stallCountRef.current = 0;
          setTimeout(() => setPlaybackStalled(false), 3000);
        }
      } else {
        stallCountRef.current = 0;
        setPlaybackStalled(false);
      }
      
      lastTimeUpdateRef.current = currentTime;
      setLastPlaybackTime(currentTime);
    }, 1000);
  }, [addLog]);

  // Add cache-busting network filter (optional)
  const setupNetworkFilters = useCallback((player) => {
    try {
      const networkingEngine = player.getNetworkingEngine();
      
      if (networkingEngine) {
        // Only add simple logging filter, no URL modification initially
        networkingEngine.registerResponseFilter((type, response) => {
          if (response.status === 404 && type === shaka.net.NetworkingEngine.RequestType.SEGMENT) {
            addLog(`404 error on segment request, this may indicate cache issues`);
          }
        });
        
        addLog('Network response filter registered for monitoring');
      }
    } catch (e) {
      addLog(`Warning: Could not setup network filters: ${e.message}`);
    }
  }, [addLog]);

  // Force reload with cache busting
  const forceReload = useCallback(async () => {
    if (!playerRef.current || !manifestUrlToLoad) return;
    
    addLog('Force reloading stream with cache busting...');
    setError(null);
    
    try {
      await playerRef.current.unload();
      
      // Add cache buster to URL
      const url = new URL(manifestUrlToLoad);
      url.searchParams.set('_reload', Date.now());
      const cacheBustedUrl = url.toString();
      
      addLog(`Reloading with cache-busted URL: ${cacheBustedUrl}`);
      await playerRef.current.load(cacheBustedUrl);
      
      addLog('Stream reloaded successfully');
    } catch (e) {
      addLog(`Error during force reload: ${e.message}`);
      setError(`Reload failed: ${e.message}`);
      
      // Fallback: try loading original URL
      try {
        addLog('Trying fallback load with original URL...');
        await playerRef.current.load(manifestUrlToLoad);
        addLog('Fallback load successful');
      } catch (fallbackError) {
        addLog(`Fallback load also failed: ${fallbackError.message}`);
      }
    }
  }, [manifestUrlToLoad, addLog]);

  // Initialize Shaka Player with enhanced configuration
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

      // Apply optimized configuration
      const config = getOptimizedPlayerConfig();
      player.configure(config);
      addLog('Applied optimized player configuration');

      // Test basic player functionality
      addLog(`Player version: ${shaka.Player.version}`);
      addLog(`Browser supported: ${shaka.Player.isBrowserSupported()}`);

      // Setup network filters for monitoring
      setupNetworkFilters(player);

      const ui = new shaka.ui.Overlay(player, videoContainerRef.current, videoRef.current);
      uiRef.current = ui;
      ui.getControls();
      addLog('Shaka UI Overlay initialized.');

      // Enhanced error handling
      player.addEventListener('error', (event) => {
        const errorDetail = event.detail;
        addLog(`PLAYER ERROR: Code: ${errorDetail.code}, Category: ${errorDetail.category}, Message: ${errorDetail.message}`);
        
        // Specific handling for cache/network related errors
        if (errorDetail.category === shaka.util.Error.Category.NETWORK) {
          addLog('Network error detected - this may be cache related');
          setTimeout(() => {
            if (window.confirm('Network error detected. Would you like to try reloading the stream?')) {
              forceReload();
            }
          }, 1000);
        }
        
        setError(`Player Error: ${errorDetail.message} (Code: ${errorDetail.code})`);
        setIsLoading(false);
        setIsSwitching(false);
        clearSwitchTimeout();
      });

      // Enhanced variant change handling
      player.addEventListener('variantchanged', () => {
        const newVariant = player.getVariantTracks().find(v => v.active);
        if (newVariant) {
          addLog(`EVENT: variantchanged. New active variant - ID: ${newVariant.id}, Label: "${newVariant.label}"`);
        }
        setIsSwitching(false);
        clearSwitchTimeout();
        
        if (playerRef.current && abrEnabled) {
          addLog("Re-enabling ABR manager after variant change");
          playerRef.current.configure({ abr: { enabled: true } });
        }
      });

      // Add additional event listeners for monitoring
      player.addEventListener('streaming', () => {
        // Reset stall detection when streaming starts
        stallCountRef.current = 0;
      });

      player.addEventListener('buffering', (event) => {
        addLog(`EVENT: buffering. State: ${event.buffering}`);
        if (event.buffering) {
          stallCountRef.current = 0; // Reset stall counter during buffering
        }
      });
      
      player.addEventListener('loading', () => {
        addLog('EVENT: loading. Player loading data.');
      });

      // Setup stall detection
      setupStallDetection();

      setIsPlayerReady(true);
      addLog('Shaka Player is ready with enhanced cache handling.');
    }

    return () => {
      addLog('App component unmounting. Destroying Shaka Player...');
      
      if (stallCheckIntervalRef.current) {
        clearInterval(stallCheckIntervalRef.current);
      }
      
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
  }, [addLog, clearSwitchTimeout, getOptimizedPlayerConfig, setupNetworkFilters, setupStallDetection, forceReload, abrEnabled]);

  function extractProgramNameFromOriginalId(originalVideoId) {
    if (!originalVideoId) return null;
    
    const programWithDimensionsMatch = originalVideoId.match(/_([^_]+)_\d+_\d+\.m3u8$/);
    if (programWithDimensionsMatch) {
        return programWithDimensionsMatch[1];
    }
    
    const generalMatch = originalVideoId.match(/_([^_]+)\.m3u8$/);
    if (generalMatch) {
        return generalMatch[1];
    }
    
    return null;
  }

  // Enhanced manifest loading with cache handling
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
      setPlaybackStalled(false);
      clearSwitchTimeout();
      
      manifestVersionRef.current += 1;
      const currentManifestVersion = manifestVersionRef.current;

      try {
        // Try loading without cache busting first
        addLog(`Loading manifest: ${manifestUrlToLoad}`);
        await playerRef.current.load(manifestUrlToLoad);
        
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
              manifestVersion: currentManifestVersion
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

        // Start monitoring for live streams
        if (playerRef.current.isLive()) {
          addLog('Live stream detected - monitoring enabled');
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

  // Enhanced variant switching
  useEffect(() => {
    if (!selectedProgramLabel || !playerRef.current || programs.length === 0 || !isPlayerReady) {
      return;
    }

    if (isSwitching) {
      addLog(`Switch already in progress, ignoring request for "${selectedProgramLabel}"`);
      return;
    }

    const programData = programs.find(p => p.label === selectedProgramLabel);
    if (!programData || !programData.variantId) {
      addLog(`Warning: No program data found for "${selectedProgramLabel}"`);
      return;
    }

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
          addLog(`Player state before switch: Paused=${me.paused}, ReadyState=${me.readyState}, CurrentTime=${me.currentTime}`);
      }
      
      addLog("Disabling ABR manager to prevent automatic switching");
      playerRef.current.configure({ abr: { enabled: false } });
      
      playerRef.current.selectVariantTrack(variantToSelect, true);
      addLog(`selectVariantTrack called for "${selectedProgramLabel}" (ID: ${variantToSelect.id})`);
      
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
  }, [selectedProgramLabel, programs, isPlayerReady, addLog, clearSwitchTimeout]);

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
          <button onClick={forceReload} disabled={isLoading || isSwitching || !manifestUrlToLoad}>
            Force Reload
          </button>
          <button onClick={() => addLog(`Player ready: ${isPlayerReady}, URL: ${manifestUrlToLoad || 'none'}`)} disabled={isLoading || isSwitching}>
            Debug Info
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}
        
        {playbackStalled && (
          <div className="stall-warning" style={{backgroundColor: '#ffeb3b', padding: '10px', margin: '10px 0', borderRadius: '4px'}}>
            ⚠️ Playback stall detected. Attempting automatic recovery...
          </div>
        )}

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
            
            <div style={{ marginTop: '10px', fontSize: '12px', color: '#666' }}>
              Current Time: {lastPlaybackTime.toFixed(1)}s
              {playbackStalled && <span style={{color: 'red'}}> - STALLED</span>}
            </div>
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