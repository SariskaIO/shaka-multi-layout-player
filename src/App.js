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
          
          let layoutName = nameMatch?.[1] || videoMatch?.[1] || nextLine.match(/^([^\/]+)\//)?.[1] || nextLine.match(/Layout\d+/)?.[0];
          
          if (layoutName && bandwidthMatch && resolutionMatch) {
            if (!layoutMap.has(layoutName)) {
              layoutMap.set(layoutName, { name: layoutName, streams: [] });
            }
            layoutMap.get(layoutName).streams.push({
              bandwidth: parseInt(bandwidthMatch[1]),
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
  // State and Refs
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
  const [clickedRegion, setClickedRegion] = useState(null);
  const [allLayoutRegions, setAllLayoutRegions] = useState([]);
  const [canvasDimensions, setCanvasDimensions] = useState({ width: 1920, height: 1080 });
  const [token, setToken] = useState(null);

  const videoRef = useRef(null);
  const videoContainerRef = useRef(null);
  const playerRef = useRef(null);
  const currentLayoutRef = useRef(null);

  // --- Core Functions and Callbacks ---

  const addLog = useCallback((message) => {
    console.log(message);
    setPlayerLogs(prevLogs => [`[${new Date().toLocaleTimeString()}] ${message}`, ...prevLogs.slice(0, 49)]);
  }, []);

  const getToken = useCallback(async () => {
    let id = sessionStorage.getItem('id') || generateRandomString(10);
    let name = sessionStorage.getItem('name') || generateRandomString(8);
    sessionStorage.setItem('id', id);
    sessionStorage.setItem('name', name);
    
    let existingToken = sessionStorage.getItem('token');
    if (existingToken) return existingToken;
    
    const response = await fetch(`${API_BASE_URL}/api/v1/misc/generate-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey: DEFAULT_API_KEY, user: { id, name, moderator: true } }),
    });

    if (!response.ok) throw new Error(`Failed to generate token: ${response.status}`);
    const { token } = await response.json();
    sessionStorage.setItem('token', token);
    return token;
  }, []);

  const fetchAllLayoutRegions = useCallback(async () => {
    if (!token || !manifestUrlToLoad) return;
    
    try {
      const urlParts = manifestUrlToLoad.split('/');
      const hlsIndex = urlParts.findIndex(part => part === 'hls');
      if (hlsIndex === -1 || hlsIndex + 2 >= urlParts.length) {
        throw new Error('Could not parse stream path from HLS URL');
      }
      const streamPath = `${urlParts[hlsIndex + 1]}/${urlParts[hlsIndex + 2]}`;
      
      const response = await fetch(`${API_BASE_URL}/terraform/v1/hooks/srs/fetchAllLayoutRegions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ stream_path: streamPath }),
      });
      
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      const data = await response.json();
      
      if (data.updated && Array.isArray(data.data)) {
        setAllLayoutRegions(data.data);
        addLog(`Successfully loaded ${data.data.length} layout configurations.`);
      }
    } catch (error) {
      addLog(`Failed to fetch layout regions: ${error.message}`);
    }
  }, [token, manifestUrlToLoad, addLog]);

  const mapRegionsToCurrentLayout = useCallback(() => {
    if (!selectedLayout || allLayoutRegions.length === 0) {
      setRegions([]);
      return;
    }
    const currentLayout = allLayoutRegions.find(l => l.layout_name.toLowerCase() === selectedLayout.toLowerCase());
    if (currentLayout) {
      setRegions(currentLayout.regions || []);
      setCanvasDimensions({
        width: currentLayout.canvas_width || 1920,
        height: currentLayout.canvas_height || 1080
      });
    } else {
      setRegions([]);
    }
  }, [selectedLayout, allLayoutRegions]);

  // --- Event Handlers ---

  const handleVideoClick = (e) => {
    // const target = e.target;
    // if (target.closest('.shaka-controls-container')) return;
    // e.preventDefault();
    // e.stopPropagation();
    console.log("jejnqejne")
    if (layouts.length <= 1) return;

    const containerRect = videoContainerRef.current.getBoundingClientRect();
    const video = videoRef.current;
    const videoAspectRatio = (video.videoWidth / video.videoHeight) || (16/9);
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

    const hitRegion = regions.find(r => 
        canvasClickX >= r.x && canvasClickX <= (r.x + r.width) &&
        canvasClickY >= r.y && canvasClickY <= (r.y + r.height)
    );

    let nextLayoutName;
    if (hitRegion) {
        setClickedRegion(hitRegion);
        const targetLayout = layouts[hitRegion.source_idx];
        console.log("hitRegion", hitRegion, targetLayout.name , layouts);

        if (targetLayout && targetLayout.name !== selectedLayout) {
            

            nextLayoutName = targetLayout.name;
        }
    }
    
    if (!nextLayoutName) {
        const currentIndex = layouts.findIndex(l => l.name === selectedLayout);
        const nextIndex = (currentIndex + 1) % layouts.length;
        nextLayoutName = layouts[nextIndex].name;
    }
    setSelectedLayout(nextLayoutName);
  };
  
  const handleLoadClick = () => {
    if (hlsUrl.trim()) {
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

  useEffect(() => {
    getToken().then(setToken).catch(err => {
      addLog(`Token initialization failed: ${err.message}`);
      setError('Failed to initialize authentication');
    });
  }, [getToken, addLog]);

  useEffect(() => {
    addLog('Initializing Shaka Player...');
    shaka.polyfill.installAll();
    if (!shaka.Player.isBrowserSupported()) {
      setError('Browser not supported by Shaka Player.');
      return;
    }

    const player = new shaka.Player(videoRef.current);
    playerRef.current = player;
    const ui = new shaka.ui.Overlay(player, videoContainerRef.current, videoRef.current);
    ui.getControls();

    player.addEventListener('error', (event) => {
      const errorDetail = event.detail;
      if (errorDetail.code === shaka.util.Error.Code.LOAD_INTERRUPTED) {
        addLog('INFO: Load interrupted by new layout switch. This is normal.');
        return;
      }
      setError(`Player Error: ${errorDetail.message} (Code: ${errorDetail.code})`);
      setIsLoading(false);
      setIsSwitching(false);
    });

    setIsPlayerReady(true);
    addLog('Shaka Player is ready.');

    return () => {
      player.destroy().then(() => addLog('Player destroyed.'));
    };
  }, [addLog]);

  useEffect(() => {
    if (playerRef.current) {
        playerRef.current.configure({ abr: { enabled: abrEnabled } });
        addLog(`ABR is now ${abrEnabled ? 'enabled' : 'disabled'}.`);
    }
  }, [abrEnabled, addLog]);

  useEffect(() => {
    if (!manifestUrlToLoad || !isPlayerReady) return;

    const loadManifest = async () => {
      setIsLoading(true);
      setError(null);
      setLayouts([]);
      setAllLayoutRegions([]);
      
      try {
        const parsedLayouts = await parseManifestForLayouts(manifestUrlToLoad, addLog);
        setLayouts(parsedLayouts);
        
        if (parsedLayouts.length > 0) {
          await fetchAllLayoutRegions();
          setSelectedLayout(parsedLayouts[0].name);
        } else {
          setError('No layouts found in manifest');
        }
      } catch (error) {
        setError(`Error loading manifest: ${error.message}`);
      } finally {
        setIsLoading(false);
      }
    };
    loadManifest();
  }, [manifestUrlToLoad, isPlayerReady, fetchAllLayoutRegions, addLog]);

  useEffect(() => {
    if (!selectedLayout || !isPlayerReady || !layouts.length || isLoading) return;
    
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
        console.error(`Error in loadLayout: `, error);
      } finally {
        setIsSwitching(false);
      }
    };
    loadLayout();
  }, [selectedLayout, isPlayerReady, layouts, isLoading, addLog]);

  useEffect(() => {
    mapRegionsToCurrentLayout();
  }, [selectedLayout, allLayoutRegions, mapRegionsToCurrentLayout]);

  // --- Render Logic ---

  const isBusy = isLoading || isSwitching;

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
          <button onClick={handleLoadClick} disabled={isBusy || !isPlayerReady || !token}>
            {isBusy ? 'Loading...' : (isPlayerReady ? (token ? 'Load Stream' : 'Auth Init...') : 'Player Init...')}
          </button>
        </div>

        {error && <p className="error-message">{error}</p>}

        <div 
          ref={videoContainerRef} 
          className="video-container" 
          onClick={handleVideoClick}
        >
          <video
            ref={videoRef}
            id="video"
            autoPlay
            controls={false}
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

        {clickedRegion && (
          <div className="info-box green">
            Clicked Region: {clickedRegion.source_type || 'Source'} {clickedRegion.source_idx + 1}
          </div>
        )}
        {regions.length > 0 && (
          <div className="info-box blue">
            <h4>Layout Regions ({regions.length}) - Canvas: {canvasDimensions.width}x{canvasDimensions.height}</h4>
            <div className="small-text">
              {regions.map((region, index) => (
                <div key={region.id || index}>
                  Region {index + 1}: {region.source_type} {region.source_idx + 1} ({region.x}, {region.y}, {region.width}x{region.height})
                </div>
              ))}
            </div>
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