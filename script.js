//------------------ Map Initialization ------------------//
const map = L.map('map').setView([0, 0], 2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

// Heatmap Legend
var legend = L.control({ position: 'bottomleft' });

legend.onAdd = function(map) {
    var div = L.DomUtil.create('div', 'leaflet-control-legend');
    div.innerHTML = `
        <p><b>Activity Density</b></p>
        <span class="gradient"></span>
        <div class="labels"><span>Low</span><span>High</span></div>
    `;
    return div;
};

map.on('overlayadd', function(e) {
    if (e.name === 'Density Heatmap') legend.addTo(map);
});
map.on('overlayremove', function(e) {
    if (e.name === 'Density Heatmap') map.removeControl(legend);
});

const polylineLayer = L.layerGroup().addTo(map);
const heatLayer = L.heatLayer([], {
  radius: 8, blur: 7, maxZoom: 17, minOpacity: 0.4,
  gradient: { 0: 'blue', 0.25: 'cyan', 0.5: 'lime', 0.75: 'yellow', 1: 'red' },
  max: 1
});

const layerControl = L.control.layers({}, { "Routes": polylineLayer, "Density Heatmap": heatLayer }).addTo(map);

//------------------ Data Storage ------------------//
const activityData = {};   // sport_type → array of latlngs
const activityMeta = {};   // sport_type → array of {date, elevation, distance, moving_time, country, name} 
let chart; // Chart.js instance

//------------------ DOM Elements ------------------//
const fileInput = document.getElementById('fileInput');
const sportFilter = document.getElementById('sportFilter');

// -----------------------
// Global state
// -----------------------
const STATE = {
  viewStart: null,
  viewEnd: null
};

//------------------ Utilities ------------------//
const m2km = m => m / 1000;
const secToPace = sec => {
  if(!isFinite(sec) || sec<=0) return "--:--";
  const m = Math.floor(sec/60), s = Math.round(sec%60).toString().padStart(2,'0');
  return `${m}:${s}`;
};

// Helper function to convert seconds to HH:MM:SS format
const secToHMS = (sec) => {
    const hours = Math.floor(sec / 3600);
    const minutes = Math.floor((sec % 3600) / 60);
    const seconds = Math.round(sec % 60);
    return [
        hours > 0 ? hours.toString().padStart(2, '0') : null,
        minutes.toString().padStart(2, '0'),
        seconds.toString().padStart(2, '0')
    ].filter(Boolean).join(':');
};

function decodePolyline(str, precision = 5) {
  let index = 0, lat = 0, lng = 0, coordinates = [];
  const factor = Math.pow(10, precision);
  while (index < str.length) {
    let b, shift = 0, result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlat = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lat += dlat;
    shift = 0; result = 0;
    do { b = str.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
    const dlng = ((result & 1) ? ~(result >> 1) : (result >> 1));
    lng += dlng;
    coordinates.push([lat / factor, lng / factor]);
  }
  return coordinates;
}

// Filtered activities by date range (defined globally for use in event listeners)
function filterByDate(act) {
    if (STATE.viewStart && act.date < STATE.viewStart) return false;
    if (STATE.viewEnd && act.date > STATE.viewEnd) return false;
    return true;
}

// -----------------------
// Activity filtering logic for all components (DRY principle)
// -----------------------
function getFilteredActivities(selectedSport, bounds, filterByDate) {
    let acts = [];
    const sportsToUse = selectedSport === "all" ? Object.keys(activityMeta) : [selectedSport];

    sportsToUse.forEach(sport => {
        (activityMeta[sport] || []).forEach((act, idx) => {
            if (!act || !filterByDate(act)) return; 
            
            const activityCoords = activityData[sport] ? activityData[sport][idx] : null;

            // Bounds check - only include activity if it has coords and intersects bounds
            if (bounds) {
                if (!activityCoords) return; 
                
                const poly = L.polyline(activityCoords);
                if (!poly.getBounds().intersects(bounds)) return;
            }
            
            // If it passes all filters, push it
            acts.push({
                meta: act,
                coords: activityCoords,
                sport: sport,
                index: idx
            });
        });
    });
    return acts;
}

//------------------ KPIs ------------------//
function renderKPIs(selectedSport, bounds = null, filterByDate = ()=>true) {
  const acts = getFilteredActivities(selectedSport, bounds, filterByDate).map(a => a.meta);

  const totalDist = acts.reduce((s,a)=>s+(a.distance||0),0);
  const totalTime = acts.reduce((s,a)=>s+(a.moving_time||0),0);
  const totalElevation = acts.reduce((s,a)=>s+(a.elevation||0),0);
  const totalKm = m2km(totalDist);
  const totalHours = totalTime/3600;
  
  const avgSpeed = totalHours > 0 ? (totalKm / totalHours) : 0;
  const avgPace = totalDist > 0 ? (totalTime/totalKm) : NaN;
  
  document.getElementById("kpi-distance").textContent = totalKm.toFixed(1);
  document.getElementById("kpi-elev").textContent = `${totalElevation.toFixed(0)} m`;
  document.getElementById("kpi-pace").textContent = secToPace(avgPace);
  document.getElementById("kpi-speed").textContent = `${avgSpeed.toFixed(1)} km/h`;
  document.getElementById("kpi-count").textContent = acts.length;
}

//------------------ Geographic Summary Function (Final Fix) ------------------//
function renderGeographicSummary(selectedSport, bounds = null, filterByDate = ()=>true) {
    // 1. Use the central filtering logic to get activities that pass all checks
    const filteredActivities = getFilteredActivities(selectedSport, bounds, filterByDate);

    // 2. Initialize Sets
    const uniqueCountries = new Set();
    const uniqueCities = new Set(); 
    
    // 3. Process the filtered list
    filteredActivities.forEach(activity => {
        const act = activity.meta;

        // Check 1: Country
        if (act.country && act.country.trim() !== '') {
            uniqueCountries.add(act.country.trim());
        }
        
        // Check 2: City Proxy
        if (act.country && act.name && act.country.trim() !== '') {
            // Take the first word of the activity name as a city proxy
            const cityProxy = act.name.split(' ')[0].trim();
            
            // Only count if the proxy isn't empty and isn't just a generic placeholder (e.g., 'Activity')
            if (cityProxy && cityProxy.toLowerCase() !== 'activity') {
                 // Use a combined key for global uniqueness
                 uniqueCities.add(act.country.trim() + "_" + cityProxy);
            }
        }
    });

    // 4. Update the DOM elements (using safe checks)
    const countryEl = document.getElementById("kpi-countries");
    const cityEl = document.getElementById("kpi-cities");

    if (countryEl) {
        countryEl.textContent = uniqueCountries.size;
    } else {
        console.error("Missing DOM element: #kpi-countries");
    }

    if (cityEl) {
        cityEl.textContent = uniqueCities.size;
    } else {
        console.error("Missing DOM element: #kpi-cities");
    }
}

//------------------ Personal Bests ------------------//
function renderPersonalBests(selectedSport, bounds = null, filterByDate = ()=>true) {
    const tableBody = document.getElementById('personal-bests-table');
    
    tableBody.innerHTML = `
        <thead>
            <tr>
                <th>PB Type</th>
                <th>Value</th>
                <th>Date</th>
                <th>Activity Name</th>
            </tr>
        </thead>
        <tbody></tbody>
    `;
    const tbody = tableBody.querySelector('tbody');
    
    const acts = getFilteredActivities(selectedSport, bounds, filterByDate).map(a => a.meta);

    if (acts.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4">No activities found in the selected area.</td></tr>';
        return;
    }

    // Initialize PBs
    const pbs = {
        longestDistance: { value: 0, date: null, name: null },
        longestDuration: { value: 0, date: null, name: null }
    };

    acts.forEach((act) => {
        const activityName = act.name || (act.date ? act.date.toLocaleDateString() : 'N/A'); 

        if (act.distance > pbs.longestDistance.value) {
            pbs.longestDistance.value = act.distance;
            pbs.longestDistance.date = act.date;
            pbs.longestDistance.name = activityName;
        }

        if (act.moving_time > pbs.longestDuration.value) {
            pbs.longestDuration.value = act.moving_time;
            pbs.longestDuration.date = act.date;
            pbs.longestDuration.name = activityName;
        }
    });

    const distanceRow = `
        <tr>
            <th>Longest Distance</th>
            <td class="distance">${m2km(pbs.longestDistance.value).toFixed(2)} km</td>
            <td>${pbs.longestDistance.date ? pbs.longestDistance.date.toLocaleDateString() : '--'}</td>
            <td>${pbs.longestDistance.name || '--'}</td>
        </tr>
    `;

    const durationRow = `
        <tr>
            <th>Longest Duration</th>
            <td class="time">${secToHMS(pbs.longestDuration.value)}</td>
            <td>${pbs.longestDuration.date ? pbs.longestDuration.date.toLocaleDateString() : '--'}</td>
            <td>${pbs.longestDuration.name || '--'}</td>
        </tr>
    `;

    tbody.innerHTML = distanceRow + durationRow;
}

//------------------ Map Update Function (Includes correct fitBounds) ------------------//
function updateMap(selectedSport, filterByDate = ()=>true) {
  polylineLayer.clearLayers();
  let allCoords = [];
  const filteredActivities = getFilteredActivities(selectedSport, null, filterByDate); // Get all visible routes (ignoring map bounds for now)
  
  const currentRoutes = [];

  filteredActivities.forEach(activity => {
      const meta = activity.meta;
      const latlngs = activity.coords;

      if (!latlngs) return; // Skip if no coordinates

      const poly = L.polyline(latlngs, { color: 'blue', weight: 2, opacity: 0.6 }).addTo(polylineLayer);
      currentRoutes.push(poly);
      allCoords.push(...latlngs);

      poly.on('mouseover', function(e) {
        L.popup({ offset: L.point(0, -10), closeButton: false, autoClose: false, className: 'route-popup' })
          .setLatLng(e.latlng)
          .setContent(`
            <b>Sport:</b> ${activity.sport}<br>
            <b>Date:</b> ${meta.date.toLocaleDateString()}<br>
            <b>Distance:</b> ${(meta.distance/1000).toFixed(2)} km<br>
            <b>Elevation:</b> ${meta.elevation.toFixed(0)} m<br>
            <b>Moving time:</b> ${(meta.moving_time/3600).toFixed(2)} h<br>
            <b>Name:</b> ${meta.name || 'N/A'}
          `)
          .openOn(map);
      });
      poly.on('mouseout', () => map.closePopup());
  });

  // Fit Bounds to the new filtered routes
  if (currentRoutes.length > 0) {
    const featureGroup = L.featureGroup(currentRoutes);
    const bounds = featureGroup.getBounds();
    
    if (bounds.isValid()) {
      map.fitBounds(bounds, {
        padding: [20, 20]
      });
    }
  } else {
      if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
  }

  // Heatmap generation logic
  if (allCoords.length > 0) {
    const pointMap = {};
    allCoords.forEach(([lat, lng]) => {
      const key = lat.toFixed(5) + ',' + lng.toFixed(5);
      pointMap[key] = (pointMap[key] || 0) + 1;
    });
    const maxCount = Math.max(...Object.values(pointMap));
    const heatPoints = Object.entries(pointMap).map(([key, count]) => {
      const [lat, lng] = key.split(',').map(Number);
      const intensity = 0.3 + 0.7 * (Math.log(count + 1) / Math.log(maxCount + 1)); 
      return [lat, lng, intensity];
    });
    heatLayer.setLatLngs(heatPoints);
    if (!map.hasLayer(heatLayer)) map.addLayer(heatLayer);
  } else {
    if (map.hasLayer(heatLayer)) map.removeLayer(heatLayer);
  }
}

//------------------ Chart Update Function ------------------//
function updateChart(selectedSport, bounds = null, filterByDate = ()=>true) {
  const monthlyData = {};
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  
  const acts = getFilteredActivities(selectedSport, bounds, filterByDate).map(a => a.meta);

  acts.forEach(act => {
      const month = act.date.getMonth();
      if (!monthlyData[month]) monthlyData[month] = 0;

      if (selectedSport === "all") monthlyData[month] += 1;
      else if (["Ride","Hike","GravelRide"].includes(selectedSport)) monthlyData[month] += act.elevation;
      else if (["Run","Walk"].includes(selectedSport)) monthlyData[month] += act.distance; 
      else if (["StandUpPaddling","Snowboard"].includes(selectedSport)) monthlyData[month] += act.moving_time; 
  });
  
  const data = months.map((_, idx) => monthlyData[idx] || 0);

  let label;
  if (selectedSport === "all") label = "Activity Frequency (Count)";
  else if (["Ride","Hike","GravelRide"].includes(selectedSport)) label = "Elevation Gained (m)";
  else if (["Run","Walk"].includes(selectedSport)) label = "Distance (km)";
  else if (["StandUpPaddling","Snowboard"].includes(selectedSport)) label = "Moving Time (hours)";
  else label = selectedSport;

  const displayData = data.map(value => {
    if (["Run","Walk"].includes(selectedSport)) return (value / 1000).toFixed(1);
    if (["StandUpPaddling","Snowboard"].includes(selectedSport)) return (value / 3600).toFixed(1);
    return value.toFixed(1); 
  });

  if (!chart) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: months, datasets: [{ label, data: displayData, backgroundColor: '#d4bdd0ff', borderColor: '#b39cafff', borderWidth: 2 }] },
      options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
  } else {
    chart.data.datasets[0].label = label;
    chart.data.datasets[0].data = displayData;
    chart.update();
  }
}

//------------------ Data Processing Logic (Shared by default load and upload) ------------------//
function processData(results) {
  // Clear existing data before processing new data
  Object.keys(activityData).forEach(key => delete activityData[key]);
  Object.keys(activityMeta).forEach(key => delete activityMeta[key]);

  // Clear sport filter options (except the "all" option)
  Array.from(sportFilter.options).filter(o => o.value !== 'all').forEach(o => o.remove());


  results.data.forEach(row => {
    if (!row["map.summary_polyline"]) return;

    let sport = row["sport_type"] || "Other";
    sport = sport.replace(/\s+/g, ''); 

    if (!activityData[sport]) activityData[sport] = [];
    if (!activityMeta[sport]) activityMeta[sport] = [];

    try {
      const coords = decodePolyline(row["map.summary_polyline"]);
      const latlngs = coords.map(c => [c[0], c[1]]);
      activityData[sport].push(latlngs);

      const elevation = parseFloat(row["total_elevation_gain"]) || 0;
      const distance = parseFloat(row["distance"]) || 0;
      const moving_time = parseFloat(row["moving_time"]) || 0;
      const date = row["start_date_local"] ? new Date(row["start_date_local"]) : null;
      const country = row["location_country"] || null;
      const name = row["name"] || null; 

      if (date) activityMeta[sport].push({ date, elevation, distance, moving_time, country, name }); 
    } catch (e) {
      console.error("Invalid polyline", e);
    }
  });

  Object.keys(activityData).forEach(sport => {
    if (!Array.from(sportFilter.options).some(o => o.value === sport)) {
      const option = document.createElement('option');
      option.value = sport;
      option.text = sport;
      sportFilter.appendChild(option);
    }
  });
  
  // Set filter to 'all'
  sportFilter.value = "all";
  
  // RENDER ALL COMPONENTS ONCE AFTER DATA LOAD
  renderAll(); 

  // Hide the upload control
  document.getElementById('controls').style.display = 'none';
}

//------------------ Default Data Loader ------------------//
function loadDefaultData() {
  const defaultFilePath = 'data/nicole_strava.csv';
  console.log(`Loading default data from: ${defaultFilePath}`);

  fetch(defaultFilePath)
    .then(response => {
      if (!response.ok) {
        throw new Error(`Could not load default file. HTTP status: ${response.status}`);
      }
      return response.text();
    })
    .then(csvText => {
      Papa.parse(csvText, {
        header: true,
        complete: processData 
      });
    })
    .catch(error => {
      console.error("Dashboard failed to load default data:", error);
      document.getElementById('controls').style.display = 'block'; 
      document.getElementById('welcomeModal').style.display = 'block';
    });
}


//------------------ File Upload Handler ------------------//
fileInput.addEventListener('change', function(event) {
  const file = event.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    complete: processData
  });
});

//------------------ Date pickers & quick filters ------------------//
const fpStart = flatpickr('#startDate',{
  dateFormat:'Y-m-d',
  onChange:([d])=>{
    STATE.viewStart=d; 
    renderAll();
  }
});
const fpEnd   = flatpickr('#endDate',{
  dateFormat:'Y-m-d',
  onChange:([d])=>{
    STATE.viewEnd=d; 
    renderAll();
  }
});


//------------------ Modal ------------------//
const modal = document.getElementById('welcomeModal');
const closeBtn = document.getElementById('closeModal');
closeBtn.addEventListener('click', () => modal.style.display = 'none');
window.addEventListener('click', (e) => { if(e.target === modal) modal.style.display = 'none'; });

//------------------ Events ------------------//

// Update KPIs, Charts, PBs, and Geo Summary when map moves
map.on('moveend', () => {
  const bounds = map.getBounds();
  const sport = sportFilter.value;
  // IMPORTANT: DO NOT call updateMap here, it causes a zoom loop.
  updateChart(sport, bounds, filterByDate);
  renderKPIs(sport, bounds, filterByDate);   
  renderPersonalBests(sport, bounds, filterByDate); 
  renderGeographicSummary(sport, bounds, filterByDate); 
});

// Update Map (zoom/routes), KPIs, Charts, PBs, and Geo Summary when sport filter changes
sportFilter.addEventListener('change', function() {
  renderAll();
});


// -----------------------
// Render All (central refresh)
// -----------------------
function renderAll() {
  const sport = sportFilter.value;
  const bounds = map.getBounds();

  // 1. Map Update: Includes the logic for fitBounds based on new filters
  updateMap(sport, filterByDate); 

  // 2. Geographic Summary Update: Must be called after map update determines the overall set of visible data
  renderGeographicSummary(sport, bounds, filterByDate); 
  
  // 3. KPI Update
  renderKPIs(sport, bounds, filterByDate);
  
  // 4. Chart Update
  updateChart(sport, bounds, filterByDate);
  
  // 5. PBs Update
  renderPersonalBests(sport, bounds, filterByDate); 
}

//------------------ Initialization ------------------//
loadDefaultData();