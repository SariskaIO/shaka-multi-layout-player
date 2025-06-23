import React, { useState, useEffect, useRef, useCallback } from 'react';
import 'shaka-player/dist/controls.css';
import './App.css';

// Load Shaka Player library at the top level
const shaka = require('shaka-player/dist/shaka-player.ui.js');

// --- Configuration ---
const configs = {
  development: {
    API_BASE_URL: 'https://api.dev.sariska.io',
    MEETING_HOST_URL: 'https://meet.dev.sariska.io',
    DEFAULT_API_KEY: '22fd6f9d8dcb0d402d20d9ba34e5acc46dc34db99eb675913e'
  },
  production: {
    API_BASE_URL: 'https://api.sariska.io',
    MEETING_HOST_URL: 'https://meet.sariska.io',
    DEFAULT_API_KEY: '27fd6f9e85c304447d3cc0fb31e7ba8062df58af86ac3f9437'
  }
};

// Use development config - change to production as needed
const { API_BASE_URL, DEFAULT_API_KEY } = configs.development;

// --- Helper Functions (defined outside the component for performance) ---
const generateRandomString = (length) => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

const parseManifestForLayouts = async (manifestUrl, addLog) => {
    try {
      addLog('Fetching and parsing HLS manifest...');
      const response = await fetch(manifestUrl);
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const manifestText = await response.text();
      addLog('Manifest fetched. Parsing for layouts...');

      const lines = manifestText.split('\n');
      const layoutMap = new Map();
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (line.startsWith('#EXT-X-STREAM-INF:')) {
          const nextLine = lines[i + 1]?.trim();
          if (!nextLine || nextLine.startsWith('#')) continue;
          
          const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
          const resolutionMatch = line.match(/RESOLUTION=(\d+x\d+)/);
          const nameMatch = line.match(/NAME="([^"]+)"/);
          const videoMatch = line.match(/VIDEO="([^"]+)"/);
          
          let layoutName = nameMatch?.[1] || videoMatch?.[1];
          if (!layoutName) {
              const pathParts = nextLine.split('/');
              if (pathParts.length > 1) {
                  layoutName = pathParts[pathParts.length - 2];
              }
          }
          
          if (layoutName && bandwidthMatch && resolutionMatch) {
            if (!layoutMap.has(layoutName)) {
              layoutMap.set(layoutName, { name: layoutName, streams: [] });
            }
            layoutMap.get(layoutName).streams.push({
              bandwidth: parseInt(bandwidthMatch[1], 10),
              resolution: resolutionMatch[1],
            });
          }
        }
      }
      
      const baseUrl = manifestUrl.substring(0, manifestUrl.lastIndexOf('/') + 1);
      const layoutsArray = Array.from(layoutMap.values()).map(layout => ({
        name: layout.name,
        displayName: layout.name,
        masterUrl: `${baseUrl}${layout.name}/master.m3u8`,
      }));
      
      layoutsArray.sort((a, b) => a.name.localeCompare(b.name));
      addLog(`Parsed ${layoutsArray.length} layouts: ${layoutsArray.map(l => l.name).join(', ')}`);
      return layoutsArray;
    } catch (error) {
      addLog(`Error parsing manifest: ${error.message}`);
      throw error;
    }
};

// --- The Main React Component ---
function App() {
  // --- State and Refs ---
  const [hlsUrl, setHlsUrl] = useState('https://edge.dev.sariska.io/hls/fhzcayypmrwoxgzs/e54476bf3d954deab9a4ca82f1a889bd/master.m3u8');
  const [manifestUrlToLoad, setManifestUrlToLoad] = useState('');
  const [layouts, setLayouts] = useState([]);
  const [selectedLayout, setSelectedLayout] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitching, setIsSwitching] = useState(false);
  const [error, setError] = useState(null);
  const [isPlayerReady, setIsPlayerReady] = useState(false);
  const [playerLogs, setPlayerLogs] = useState([]);
  const [abrEnabled, setAbrEnabled] = useState(true);
  const [regions, setRegions] = useState([]);
  const [allLayoutRegions, setAllLayoutRegions] = useState([]);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1920, height: 1080 });
  const [token, setToken] = useState(null);

  // New state for manual token handling
  const [manualToken, setManualToken] = useState('');
  const [showManualTokenInput, setShowManualTokenInput] = useState(false);
  const [isTokenLoading, setIsTokenLoading] = useState(false);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const uiRef = useRef(null);
  const currentLayoutRef = useRef(null);
  
  // --- Core Functions and Callbacks ---
  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prevLogs.slice(0, 99)]);
  }, []);

  // Updated getToken function with better error handling
  const getToken = useCallback(async () => {
    // Check if API_BASE_URL is properly configured
    if (!API_BASE_URL || API_BASE_URL.includes('undefined')) {
      throw new Error('API_BASE_URL is not properly configured');
    }

    let id = sessionStorage.getItem('id') || generateRandomString(10);
    let name = sessionStorage.getItem('name') || generateRandomString(8);
    sessionStorage.setItem('id', id);
    sessionStorage.setItem('name', name);
    
    let existingToken = sessionStorage.getItem('token');
    if (existingToken) {
      addLog('Using existing token from session storage');
      return existingToken;
    }
    
    try {
      addLog('Attempting to generate authentication token...');
      
      const response = await fetch(`${API_BASE_URL}/api/v1/misc/generate-token`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        mode: 'cors', // Explicitly set CORS mode
        credentials: 'omit', // Don't send credentials unless necessary
        body: JSON.stringify({ 
          apiKey: DEFAULT_API_KEY, 
          user: { id, name, moderator: true } 
        }),
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const data = await response.json();
      if (!data.token) {
        throw new Error('No token received from server');
      }
      
      sessionStorage.setItem('token', data.token);
      addLog('Authentication token generated successfully');
      return data.token;
      
    } catch (error) {
      addLog(`Token generation failed: ${error.message}`);
      
      // Enhanced CORS error detection
      if (error.message.includes('CORS') || 
          error.message.includes('Failed to fetch') || 
          error.message.includes('Network request failed') ||
          error.name === 'TypeError') {
        
        addLog('CORS Error detected. This usually means:');
        addLog('1. The server needs to allow your domain in CORS settings');
        addLog('2. Try running your React app from localhost instead');
        addLog('3. Contact the API provider to whitelist your domain');
        
        // Throw a specific CORS error
        const corsError = new Error('CORS_ERROR: Unable to connect to API due to Cross-Origin restrictions');
        corsError.isCorsError = true;
        throw corsError;
      }
      
      throw error;
    }
  }, [addLog]);

  // Manual token application function
  const applyManualToken = useCallback(() => {
    if (manualToken.trim()) {
      sessionStorage.setItem('token', manualToken.trim());
      setToken(manualToken.trim());
      setError(null);
      setShowManualTokenInput(false);
      addLog('Manual token applied successfully');
    }
  }, [manualToken, addLog]);

  // Clear token function
  const clearToken = useCallback(() => {
    sessionStorage.removeItem('token');
    setToken(null);
    setManualToken('');
    setShowManualTokenInput(false);
    addLog('Token cleared from session');
  }, [addLog]);

  const fetchAllLayoutRegions = useCallback(async () => {
    if (!token || !manifestUrlToLoad) return;
    
    try {
      // Check if API_BASE_URL is properly configured
      if (!API_BASE_URL || API_BASE_URL.includes('undefined')) {
        throw new Error('API_BASE_URL is not properly configured');
      }

      const urlParts = manifestUrlToLoad.split('/');
      const hlsIndex = urlParts.findIndex(part => part === 'hls');
      if (hlsIndex === -1 || hlsIndex + 2 >= urlParts.length) {
        throw new Error('Could not parse stream path from HLS URL');
      }

      const streamPath = `${urlParts[hlsIndex + 1]}/${urlParts[hlsIndex + 2]}`;
      addLog(`Fetching layout regions for stream path: ${streamPath}`);
      
      const response = await fetch(`${API_BASE_URL}/terraform/v1/hooks/srs/fetchAllLayoutRegions`, {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json', 
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        },
        mode: 'cors',
        body: JSON.stringify({ stream_path: streamPath }),
      });
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      
      if (Array.isArray(data.data)) {
        setAllLayoutRegions(data.data);
        addLog(`Successfully loaded ${data.data.length} layout configurations.`);
      }
    } catch (error) {
      addLog(`Failed to fetch layout regions: ${error.message}`);
      if (error.message.includes('CORS') || error.message.includes('Failed to fetch')) {
        addLog('Layout regions fetch blocked by CORS - this may affect region clicking functionality');
      }
    }
  }, [token, manifestUrlToLoad, addLog]);

  const mapRegionsToCurrentLayout = useCallback(() => {
    if (!selectedLayout || allLayoutRegions.length === 0) {
      setRegions([]);
      return;
    }

    const currentLayoutData = allLayoutRegions.find(l => l.layout_name.toLowerCase() === selectedLayout.toLowerCase());
    if (currentLayoutData) {
      setRegions(currentLayoutData.regions || []);
      setCanvasDimensions({
        width: currentLayoutData.canvas_width || 1920,
        height: currentLayoutData.canvas_height || 1080
      });
    } else {
      setRegions([]);
    }
  }, [selectedLayout, allLayoutRegions]);

  // FIXED: Complete reset function for proper reload
  const resetAllState = useCallback(() => {
    addLog('Resetting all state for new stream...');
    setLayouts([]);
    setSelectedLayout('');
    setRegions([]);
    setAllLayoutRegions([]);
    setCanvasDimensions({ width: 1920, height: 1080 });
    setError(null);
    currentLayoutRef.current = null;
    
    // Stop current playback if player exists
    if (playerRef.current) {
      try {
        playerRef.current.unload();
      } catch (e) {
        addLog(`Warning: Error during player unload: ${e.message}`);
      }
    }
  }, [addLog]);

  const handleVideoClick = (e) => {
    if (layouts.length <= 1 || !videoRef.current || !videoContainerRef.current) return;
  
    const containerRect = videoContainerRef.current.getBoundingClientRect();
    const video = videoRef.current;
    if (!video.videoWidth || !video.videoHeight) return;

    const videoAspectRatio = video.videoWidth / video.videoHeight;
    const containerAspectRatio = containerRect.width / containerRect.height;
    
    let videoDisplayWidth, videoDisplayHeight, offsetX, offsetY;
    if (containerAspectRatio > videoAspectRatio) {
        videoDisplayHeight = containerRect.height;
        videoDisplayWidth = videoDisplayHeight * videoAspectRatio;
        offsetX = (containerRect.width - videoDisplayWidth) / 2;
        offsetY = 0;
    } else {
        videoDisplayWidth = containerRect.width;
        videoDisplayHeight = videoDisplayWidth / videoAspectRatio;
        offsetX = 0;
        offsetY = (containerRect.height - videoDisplayHeight) / 2;
    }
    
    const clickX = e.clientX - containerRect.left;
    const clickY = e.clientY - containerRect.top;
    
    const canvasClickX = ((clickX - offsetX) / videoDisplayWidth) * canvasDimensions.width;
    const canvasClickY = ((clickY - offsetY) / videoDisplayHeight) * canvasDimensions.height;
  
    if (regions.length === 0) return;

    const largestRegion = regions.reduce((largest, current) => {
      if (!largest) return current;
      const currentArea = (current.width || 0) * (current.height || 0);
      const largestArea = (largest.width || 0) * (largest.height || 0);
      return currentArea > largestArea ? current : largest;
    }, null);
  
    const clickableRegions = regions.filter(region => region !== largestRegion);
  
    const hitRegion = clickableRegions.find(r => 
        canvasClickX >= r.x && canvasClickX <= (r.x + r.width) &&
        canvasClickY >= r.y && canvasClickY <= (r.y + r.height)
    );
  
    if (hitRegion) {
        addLog(`Clicked region for participant: ${hitRegion.source_type} ${hitRegion.source_idx}`);
        const nextLayoutNameFromApi = hitRegion.parent_layout_name;

        const nextLayout = layouts.find(l => l.name.toLowerCase() === nextLayoutNameFromApi.toLowerCase());

        if (nextLayout && nextLayout.name !== selectedLayout) {
          addLog(`Switching to corresponding layout: ${nextLayout.name}`);
          setSelectedLayout(nextLayout.name);
        } else if (!nextLayout) {
          addLog(`Warning: Clicked region points to a layout "${nextLayoutNameFromApi}" that was not found in the manifest.`);
        }
    }
  };
  
  // FIXED: Proper load handler with complete reset
  const handleLoadClick = () => {
    if (hlsUrl.trim()) {
      resetAllState(); // Reset everything first
      setManifestUrlToLoad(hlsUrl.trim());
    } else {
      setError("Please enter an HLS URL.");
    }
  };

  const handleLayoutChange = (event) => {
    if (isLoading || isSwitching) return;
    setSelectedLayout(event.target.value);
  };
  
  // --- Lifecycle and Player Effects ---

  // Token initialization with improved error handling
  useEffect(() => {
    const initToken = async () => {
      setIsTokenLoading(true);
      try {
        const token = await getToken();
        setToken(token);
        setError(null);
        setShowManualTokenInput(false);
      } catch (err) {
        const errorMessage = err.message;
        addLog(`Token initialization failed: ${errorMessage}`);
        
        if (err.isCorsError || errorMessage.includes('CORS') || errorMessage.includes('Failed to fetch')) {
          setError('Connection blocked by CORS policy. Please use manual token input below.');
          setShowManualTokenInput(true);
        } else {
          setError(`Authentication failed: ${errorMessage}`);
        }
      } finally {
        setIsTokenLoading(false);
      }
    };
    
    initToken();
  }, [getToken, addLog]);

  // Player initialization - runs only once
  useEffect(() => {
    addLog('Initializing Shaka Player...');
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      setError('Browser not supported by Shaka Player.');
      return;
    }

    const player = new shaka.Player();
    playerRef.current = player;
    player.attach(videoRef.current);

    const ui = new shaka.ui.Overlay(player, videoContainerRef.current, videoRef.current);
    uiRef.current = ui;
    ui.getControls();

    const playerConfiguration = {
      abr: {
        defaultBandwidthEstimate: 1500000,
        bandwidthUpgradeTarget: 1.15,
        bandwidthDowngradeTarget: 1.05,
      },
      streaming: {
        bufferingGoal: 30,
        rebufferingGoal: 2, 
        retryParameters: {
          maxAttempts: 4,
          baseDelay: 1000,
          backoffFactor: 2,
          fuzzFactor: 0.5,
        }
      }
    };
    player.configure(playerConfiguration);
    addLog(`Player configured: bufferingGoal=30s, rebufferingGoal=2s, conservative ABR`);
    
    // Event Listeners
    player.addEventListener('error', (event) => {
      const error = event.detail;
      addLog(`Player Error: ${error.code} - ${error.message}`);
      setError(`Player Error: ${error.message}`);
    });
    
    player.addEventListener('buffering', e => {
      addLog(`Buffering: ${e.buffering ? 'started' : 'ended'}`);
    });
    
    player.addEventListener('adaptation', () => {
      const stats = player.getStats();
      addLog(`Adaptation: ${stats.width}x${stats.height} @ ${Math.round(stats.estimatedBandwidth/1000)}kbps`);
    });
    
    player.addEventListener('stalldetected', () => {
      addLog('Stall detected - playback may be interrupted');
    });

    setIsPlayerReady(true);
    addLog('Shaka Player is ready.');

    return () => {
      addLog('Destroying player and UI instances...');
      uiRef.current?.destroy();
      playerRef.current?.destroy().then(() => {
        addLog('Player destroyed.');
      });
      playerRef.current = null;
      uiRef.current = null;
    };
  }, []); 

  useEffect(() => {
    if (playerRef.current) {
        playerRef.current.configure({ abr: { enabled: abrEnabled } });
        addLog(`ABR is now ${abrEnabled ? 'enabled' : 'disabled'}.`);
    }
  }, [abrEnabled, addLog]);

  // FIXED: Better manifest loading with proper cleanup
  useEffect(() => {
    if (!manifestUrlToLoad || !isPlayerReady || !token) return;

    const loadManifest = async () => {
      setIsLoading(true);
      setError(null);
      setPlayerLogs([]); // Clear logs for new load
      addLog(`Loading manifest: ${manifestUrlToLoad}`);
      
      try {
        const parsedLayouts = await parseManifestForLayouts(manifestUrlToLoad, addLog);
        setLayouts(parsedLayouts);
        
        if (parsedLayouts.length > 0) {
          await fetchAllLayoutRegions();
          setSelectedLayout(parsedLayouts[0].name);
        } else {
          setError('No layouts found in manifest');
          addLog('ERROR: No layouts could be parsed from the manifest.');
        }
      } catch (error) {
        setError(`Error loading manifest: ${error.message}`);
        addLog(`Error loading manifest: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };
    
    loadManifest();
  }, [manifestUrlToLoad, isPlayerReady, token, fetchAllLayoutRegions, addLog]);

  useEffect(() => {
    if (!selectedLayout || !isPlayerReady || !layouts.length || isLoading || !playerRef.current) return;
    
    const layoutData = layouts.find(l => l.name === selectedLayout);
    if (!layoutData || currentLayoutRef.current === selectedLayout) return;

    const loadLayout = async () => {
      setIsSwitching(true);
      setError(null);
      const currentTime = videoRef.current?.currentTime || 0;
      
      try {
        addLog(`Switching to layout: ${selectedLayout}`);
        await playerRef.current.load(layoutData.masterUrl, currentTime > 1 ? currentTime : 0);
        currentLayoutRef.current = selectedLayout;
        addLog(`Successfully loaded: ${selectedLayout}`);
      } catch (error) {
        addLog(`Error loading layout: ${error.message}`);
        setError(`Error loading layout: ${error.message}`);
      } finally {
        setIsSwitching(false);
      }
    };
    loadLayout();
  }, [selectedLayout, isPlayerReady, layouts, isLoading, addLog]);

  useEffect(() => {
    mapRegionsToCurrentLayout();
  }, [selectedLayout, allLayoutRegions, mapRegionsToCurrentLayout]);

  const isBusy = isLoading || isSwitching;
  const isTokenReady = token && !isTokenLoading;

  return (
    <div className="App">
      <main>
        <div className="input-area">
          <input
            type="text"
            value={hlsUrl}
            onChange={(e) => setHlsUrl(e.target.value)}
            placeholder="Enter HLS Master Manifest URL"
            disabled={isBusy}
          />
          <button onClick={handleLoadClick} disabled={isBusy || !isPlayerReady || !isTokenReady}>
            {isBusy ? 'Loading...' : (isPlayerReady ? (isTokenReady ? 'Load Stream' : (isTokenLoading ? 'Auth Init...' : 'Need Token')) : 'Player Init...')}
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}

        {/* Manual Token Input Section */}
        {showManualTokenInput && (
          <div className="manual-token-section" style={{
            padding: '15px',
            backgroundColor: '#f5f5f5',
            border: '1px solid #ddd',
            borderRadius: '4px',
            margin: '10px 0'
          }}>
            <h4>Manual Token Input (Development Only)</h4>
            <p>Due to CORS restrictions, you can manually enter a token:</p>
            <div style={{ display: 'flex', gap: '10px', alignItems: 'center', marginBottom: '10px' }}>
              <input
                type="text"
                value={manualToken}
                onChange={(e) => setManualToken(e.target.value)}
                placeholder="Paste your token here"
                style={{ flex: 1, padding: '8px' }}
              />
              <button 
                onClick={applyManualToken}
                disabled={!manualToken.trim()}
                style={{ padding: '8px 16px' }}
              >
                Apply Token
              </button>
              <button 
                onClick={clearToken}
                style={{ padding: '8px 16px', backgroundColor: '#ff6b6b', color: 'white', border: 'none', borderRadius: '4px' }}
              >
                Clear Token
              </button>
            </div>
            <small style={{ color: '#666', display: 'block' }}>
              Get a token by calling the API directly or from your server logs. 
              Current token: {token ? `${token.substring(0, 20)}...` : 'None'}
            </small>
          </div>
        )}

        <div 
          ref={videoContainerRef} 
          className="video-container" 
          onClick={handleVideoClick}
          style={{ cursor: layouts.length > 1 ? 'pointer' : 'default' }}
        >
          <video
            ref={videoRef}
            id="video"
            autoPlay
            controls={false}
            playsInline
          ></video>
        </div>

        {layouts.length > 0 && (
          <div className="controls-area">
            <div>
              <label>
                <input
                  type="checkbox"
                  checked={abrEnabled}
                  onChange={(e) => setAbrEnabled(e.target.checked)}
                  disabled={isBusy}
                />
                {' '}Enable Adaptive Bitrate (ABR)
              </label>
            </div>
            
            <label htmlFor="layout-select">Select Layout: </label>
            <select
              id="layout-select"
              value={selectedLayout}
              onChange={handleLayoutChange}
              disabled={isBusy}
            >
              {layouts.map((layout) => (
                <option key={layout.name} value={layout.name}>
                  {layout.displayName}
                </option>
              ))}
            </select>
            {isSwitching && <span className="switching-indicator"> Switching...</span>}
          </div>
        )}
        
        {regions.length > 0 && (
          <div className="info-box blue">
            <h4>Layout Regions ({regions.length}) - Canvas: {canvasDimensions.width}x{canvasDimensions.height}</h4>
            <div className="small-text">
              {regions.map((region, index) => (
                <div key={region.id || index}>
                  Region {index + 1}: {region.source_type} {region.source_idx + 1} ({region.x}, {region.y}, {region.width}x{region.height}) {region.parent_layout_name ? `-> ${region.parent_layout_name}` : ''}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Token Status Indicator */}
        {isTokenReady && (
          <div style={{ 
            padding: '10px', 
            backgroundColor: '#e8f5e8', 
            border: '1px solid #4caf50', 
            borderRadius: '4px',
            margin: '10px 0',
            fontSize: '14px'
          }}>
            ✅ Authentication Token Active: {token.substring(0, 20)}...
            <button 
              onClick={() => setShowManualTokenInput(!showManualTokenInput)}
              style={{ marginLeft: '10px', padding: '4px 8px', fontSize: '12px' }}
            >
              {showManualTokenInput ? 'Hide' : 'Manage'} Token
            </button>
          </div>
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