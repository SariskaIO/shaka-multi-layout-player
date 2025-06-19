// src/App.js
import React, { useState, useEffect, useRef, useCallback } from 'react';
import 'shaka-player/dist/controls.css';
import './App.css';

const shaka = require('shaka-player/dist/shaka-player.ui.js');

function App() {
  const [hlsUrl, setHlsUrl] = useState('https://edge.dev.sariska.io/hls/fhzcayypmrwoxgzs/e54476bf3d954deab9a4ca82f1a889bd/master.m3u8');
  const [manifestUrlToLoad, setManifestUrlToLoad] = useState('');
  const [layouts, setLayouts] = useState([]);
  const [selectedLayout, setSelectedLayout] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerLogs, setPlayerLogs] = useState([]);
  const [abrEnabled, setAbrEnabled] = useState(true); // ABR enabled for individual layouts

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const uiRef = useRef(null);
  const currentLayoutRef = useRef(null);

  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [
        `[${new Date().toLocaleTimeString()}] ${message}`,
        ...prevLogs.slice(0, 19)
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

      // Configure player
      player.configure({
        abr: {
          enabled: abrEnabled
        },
        streaming: {
          rebufferingGoal: 2,
          bufferingGoal: 10,
          bufferBehind: 30
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
      });

      player.addEventListener('variantchanged', () => {
        const newVariant = player.getVariantTracks().find(v => v.active);
        if (newVariant) {
          addLog(`EVENT: variantchanged. New active variant - Resolution: ${newVariant.width}x${newVariant.height}, Bandwidth: ${(newVariant.bandwidth/1000000).toFixed(2)}Mbps`);
        }
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
  }, [addLog, abrEnabled]);

  // Parse HLS manifest to extract all available layouts
  const parseManifestForLayouts = async (manifestUrl) => {
    try {
      addLog('Fetching and parsing HLS manifest...');
      const response = await fetch(manifestUrl);
      const manifestText = await response.text();
      
      addLog('Manifest fetched successfully. Parsing for layouts...');
      
      // Parse HLS manifest for different layouts
      const lines = manifestText.split('\n');
      const layoutMap = new Map();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        
        // Look for EXT-X-STREAM-INF lines
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const nextLine = lines[i + 1]?.trim();
          if (!nextLine || nextLine.startsWith('#')) continue;
          
          // Extract layout information from the stream info
          const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
          const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
          const nameMatch = line.match(/NAME="([^"]+)"/);
          const videoMatch = line.match(/VIDEO="([^"]+)"/);
          
          // Determine layout name
          let layoutName = nameMatch?.[1] || videoMatch?.[1];
          
          // If no name/video attribute, try to extract from URL
          if (!layoutName) {
            const urlMatch = nextLine.match(/^([^\/]+)\//);
            layoutName = urlMatch?.[1];
          }
          
          // Extract layout from URL if still not found
          if (!layoutName) {
            const layoutMatch = nextLine.match(/Layout\d+/);
            layoutName = layoutMatch?.[0];
          }
          
          if (layoutName && bandwidthMatch && resolutionMatch) {
            const bandwidth = parseInt(bandwidthMatch[1]);
            const resolution = resolutionMatch[1];
            
            if (!layoutMap.has(layoutName)) {
              layoutMap.set(layoutName, {
                name: layoutName,
                streams: [],
                bestQuality: { bandwidth: 0, resolution: '' }
              });
            }
            
            const layoutData = layoutMap.get(layoutName);
            layoutData.streams.push({
              bandwidth,
              resolution,
              streamInfoLine: line,
              streamUrlLine: nextLine
            });
            
            // Track the best quality stream for this layout
            if (bandwidth > layoutData.bestQuality.bandwidth) {
              layoutData.bestQuality = { bandwidth, resolution };
            }
          }
        }
      }
      
      // Build base URL from the original manifest URL
      const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
      
      // Convert to array and create layout-specific master playlist URLs
      const layoutsArray = Array.from(layoutMap.values()).map(layout => {
        // Create layout-specific master playlist URL
        const layoutMasterUrl = `${baseUrl}${layout.name}/master.m3u8`;
        
        addLog(`Layout "${layout.name}" master playlist URL: ${layoutMasterUrl}`);
        addLog(`  - ${layout.streams.length} quality variants available`);
        layout.streams.forEach(stream => {
          addLog(`    - ${stream.resolution} @ ${(stream.bandwidth/1000000).toFixed(2)}Mbps`);
        });
        
        return {
          name: layout.name,
          displayName: layout.name, // Just layout name, no resolution/bandwidth
          masterUrl: layoutMasterUrl,
          streams: layout.streams,
          bandwidth: layout.bestQuality.bandwidth,
          resolution: layout.bestQuality.resolution
        };
      });
      
      // Sort by layout name
      layoutsArray.sort((a, b) => a.name.localeCompare(b.name));
      
      addLog(`Parsed ${layoutsArray.length} layouts: ${layoutsArray.map(l => l.name).join(', ')}`);
      
      return layoutsArray;
      
    } catch (error) {
      addLog(`Error parsing manifest: ${error.message}`);
      throw error;
    }
  };

  // Load manifest and parse layouts
  useEffect(() => {
    if (!manifestUrlToLoad) return;

    const loadManifest = async () => {
      setIsLoading(true);
      setError(null);
      setLayouts([]);
      setSelectedLayout('');
      
      try {
        const parsedLayouts = await parseManifestForLayouts(manifestUrlToLoad);
        setLayouts(parsedLayouts);
        
        if (parsedLayouts.length > 0) {
          const firstLayout = parsedLayouts[0];
          setSelectedLayout(firstLayout.name);
          addLog(`Found ${parsedLayouts.length} layouts. Auto-loading first layout: ${firstLayout.name}`);
          
          // Auto-load the first layout
          setTimeout(() => {
            if (playerRef.current && isPlayerReady) {
              addLog(`Auto-loading first layout: ${firstLayout.name} from ${firstLayout.masterUrl}`);
              playerRef.current.load(firstLayout.masterUrl).then(() => {
                currentLayoutRef.current = firstLayout.name;
                addLog(`Successfully auto-loaded layout: ${firstLayout.name}`);
                
                // Log available variants for the first layout
                const variants = playerRef.current.getVariantTracks();
                addLog(`Layout "${firstLayout.name}" has ${variants.length} quality variants available`);
                variants.forEach(v => {
                  addLog(`  - ${v.width}x${v.height} @ ${(v.bandwidth/1000000).toFixed(2)}Mbps`);
                });
              }).catch((error) => {
                addLog(`Error auto-loading first layout: ${error.message}`);
                setError(`Error loading first layout: ${error.message}`);
              });
            }
          }, 100);
        } else {
          setError('No layouts found in manifest');
          addLog('No layouts found in the manifest');
        }
        
      } catch (error) {
        setError(`Error loading manifest: ${error.message}`);
        addLog(`Error loading manifest: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };

    loadManifest();
  }, [manifestUrlToLoad, addLog]);

  // Load specific layout when selected
  useEffect(() => {
    if (!selectedLayout || !isPlayerReady || !layouts.length) return;
    
    const layoutData = layouts.find(l => l.name === selectedLayout);
    if (!layoutData) return;
    
    // Don't reload if it's the same layout
    if (currentLayoutRef.current === selectedLayout) {
      addLog(`Layout "${selectedLayout}" is already loaded`);
      return;
    }
    
    const loadLayout = async () => {
      setIsSwitching(true);
      setError(null);
      
      try {
        addLog(`Loading layout: ${selectedLayout} from ${layoutData.masterUrl}`);
        
        // Store current time if player is already loaded
        let currentTime = 0;
        if (playerRef.current && currentLayoutRef.current) {
          try {
            currentTime = videoRef.current?.currentTime || 0;
            addLog(`Saving current playback time: ${currentTime.toFixed(2)}s`);
          } catch (e) {
            addLog('Could not get current time');
          }
        }
        
        // Load the layout-specific master playlist URL
        await playerRef.current.load(layoutData.masterUrl);
        
        // Try to seek to the previous time if switching layouts
        if (currentTime > 0 && currentLayoutRef.current) {
          try {
            setTimeout(() => {
              if (videoRef.current) {
                videoRef.current.currentTime = currentTime;
                addLog(`Restored playback time to: ${currentTime.toFixed(2)}s`);
              }
            }, 500);
          } catch (e) {
            addLog('Could not restore playback time');
          }
        }
        
        currentLayoutRef.current = selectedLayout;
        addLog(`Successfully loaded layout: ${selectedLayout}`);
        
        // Log available variants for this layout
        const variants = playerRef.current.getVariantTracks();
        addLog(`Layout "${selectedLayout}" has ${variants.length} quality variants available`);
        variants.forEach(v => {
          addLog(`  - ${v.width}x${v.height} @ ${(v.bandwidth/1000000).toFixed(2)}Mbps`);
        });
        
      } catch (error) {
        setError(`Error loading layout: ${error.message}`);
        addLog(`Error loading layout ${selectedLayout}: ${error.message}`);
      } finally {
        setIsSwitching(false);
      }
    };

    loadLayout();
  }, [selectedLayout, isPlayerReady, layouts, addLog]);

  const handleUrlChange = (event) => setHlsUrl(event.target.value);

  const handleLoadClick = () => {
    if (hlsUrl.trim()) {
      setManifestUrlToLoad(hlsUrl.trim());
    } else {
      setError("Please enter an HLS URL.");
      addLog("Load clicked with empty URL.");
    }
  };

  const handleLayoutChange = (event) => {
    const newLayout = event.target.value;
    
    if (isSwitching || isLoading) {
      addLog(`User tried to select "${newLayout}" but operation in progress.`);
      return;
    }
    
    addLog(`User selected layout: "${newLayout}"`);
    setSelectedLayout(newLayout);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>HLS Multi-Layout Player</h1>
      </header>
      <main>
        <div className="input-area">
          <input
            type="text"
            value={hlsUrl}
            onChange={handleUrlChange}
            placeholder="Enter HLS Master Manifest URL (.m3u8)"
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

        {layouts.length > 0 && (
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
                {' '}Enable Adaptive Bitrate (ABR) for quality switching within each layout
              </label>
            </div>
            
            <label htmlFor="layout-select">Select Layout: </label>
            <select
              id="layout-select"
              value={selectedLayout}
              onChange={handleLayoutChange}
              disabled={isLoading || isSwitching}
              style={{ 
                opacity: (isLoading || isSwitching) ? 0.6 : 1,
                cursor: (isLoading || isSwitching) ? 'not-allowed' : 'pointer'
              }}
            >
              {layouts.map((layout) => (
                <option key={layout.name} value={layout.name}>
                  {layout.displayName}
                </option>
              ))}
            </select>
            {isSwitching && <span className="switching-indicator"> Switching Layout...</span>}
          </div>
        )}
        
        {manifestUrlToLoad && layouts.length === 0 && !isLoading && !error && (
            <p>No layouts found, or stream not loaded.</p>
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