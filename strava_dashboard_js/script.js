//------------------ Map Initialization ------------------//
const map = L.map('map').setView([0, 0], 2);

L.tileLayer('https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png', {
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a> &copy; <a href="https://carto.com/">CARTO</a>',
  subdomains: 'abcd',
  maxZoom: 19
}).addTo(map);

// Heatmap Legend
// Create the legend but don't add it yet
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

// Show legend only when heatmap is toggled on
map.on('overlayadd', function(e) {
    if (e.name === 'Density Heatmap') {
        legend.addTo(map);
    }
});

// Remove legend when heatmap is toggled off
map.on('overlayremove', function(e) {
    if (e.name === 'Density Heatmap') {
        map.removeControl(legend);
    }
});


const polylineLayer = L.layerGroup().addTo(map);
const heatLayer = L.heatLayer([], {
  radius: 8,
  blur: 7,
  maxZoom: 17,
  minOpacity: 0.4,
  gradient: { 0: 'blue', 0.25: 'cyan', 0.5: 'lime', 0.75: 'yellow', 1: 'red' },
  max: 1
});

const layerControl = L.control.layers({}, { "Routes": polylineLayer, "Density Heatmap": heatLayer }).addTo(map);

//------------------ Data Storage ------------------//
const activityData = {}; // sport_type → array of latlngs
const activityMeta = {}; // sport_type → array of {date, elevation}

//------------------ DOM Elements ------------------//
const fileInput = document.getElementById('fileInput');
const sportFilter = document.getElementById('sportFilter');
let chart; // Chart.js instance

//------------------ File Upload Handler ------------------//
fileInput.addEventListener('change', function(event) {
  const file = event.target.files[0];
  if (!file) return;

  Papa.parse(file, {
    header: true,
    complete: function(results) {
      const bounds = [];

        results.data.forEach(row => {
        if (!row["map.summary_polyline"]) return;

        let sport = row["sport_type"] || "Other";

        // Normalize - remove spaces like ("Stand Up Paddling" → "StandUpPaddling")
        sport = sport.replace(/\s+/g, ''); 

        if (!activityData[sport]) activityData[sport] = [];
        if (!activityMeta[sport]) activityMeta[sport] = [];

        try {
            const coords = polyline.decode(row["map.summary_polyline"]);
            const latlngs = coords.map(c => [c[0], c[1]]);
            activityData[sport].push(latlngs);

            // Store meta for chart
            const elevation = parseFloat(row["total_elevation_gain"]) || 0;
            const distance = parseFloat(row["distance"]) || 0;
            const moving_time = parseFloat(row["moving_time"]) || 0;
            const date = row["start_date_local"] ? new Date(row["start_date_local"]) : null;
            if (date) activityMeta[sport].push({ date, elevation, distance, moving_time });
        } catch (e) {
            console.error("Invalid polyline", e);
        }
        });


      // Populate dropdown
      Object.keys(activityData).forEach(sport => {
        if (!Array.from(sportFilter.options).some(o => o.value === sport)) {
          const option = document.createElement('option');
          option.value = sport;
          option.text = sport;
          sportFilter.appendChild(option);
        }
      });

      updateMap("all");
      updateChart("all");

      if (bounds.length > 0) map.fitBounds(bounds);
    }
  });
});

//------------------ Map Update Function ------------------//
function updateMap(selectedSport) {
  polylineLayer.clearLayers();

  let allCoords = [];
  const sportsToShow = selectedSport === "all" ? Object.keys(activityData) : [selectedSport];
  const bounds = [];

  sportsToShow.forEach(sport => {
  activityData[sport].forEach((latlngs, idx) => {
    const poly = L.polyline(latlngs, { color: 'blue', weight: 2, opacity: 0.6 }).addTo(polylineLayer);
    allCoords.push(...latlngs);
    bounds.push(...latlngs);

    const meta = activityMeta[sport][idx]; // Get the corresponding meta

    poly.on('mouseover', function(e) {
      const popup = L.popup({
        offset: L.point(0, -10),
        closeButton: false,
        autoClose: false,
        className: 'route-popup'
      })
      .setLatLng(e.latlng)
      .setContent(`
        <b>Sport:</b> ${sport}<br>
        <b>Date:</b> ${meta.date.toLocaleDateString()}<br>
        <b>Distance:</b> ${(meta.distance/1000).toFixed(2)} km<br>
        <b>Elevation:</b> ${meta.elevation.toFixed(0)} m<br>
        <b>Moving time:</b> ${(meta.moving_time/3600).toFixed(2)} h<br>
        <b>Points:</b> ${latlngs.length}
      `)
      .openOn(map);
    });

    poly.on('mouseout', function() {
      map.closePopup();
    });
  });
});


  if (bounds.length > 0) map.fitBounds(bounds);

  //------------------ Update heatmap ------------------//
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


//------------------ Chart Update Function (with map bounds) ------------------//

function updateChart(selectedSport, bounds = null) {
  const monthlyData = {};
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const sportsToUse = selectedSport === "all" ? Object.keys(activityMeta) : [selectedSport];

  sportsToUse.forEach(sport => {
    activityMeta[sport].forEach((act, idx) => {
      // Skip if bounds provided and activity is outside map view
      if (bounds) {
        const poly = polylineLayer.getLayers()[idx];
        if (!poly || !poly.getBounds().intersects(bounds)) return;
      }

      const month = act.date.getMonth();
      if (!monthlyData[month]) monthlyData[month] = 0;

      if (selectedSport === "all") {
        monthlyData[month] += 1; // frequency
      } else if (["Ride","Hike","GravelRide"].includes(selectedSport)) {
        monthlyData[month] += act.elevation;
      } else if (["Run","Walk"].includes(selectedSport)) {
        monthlyData[month] += act.distance;
      } else if (["StandUpPaddling","Snowboard"].includes(selectedSport)) {
        monthlyData[month] += act.moving_time;
      }
    });
  });

  const data = months.map((_, idx) => monthlyData[idx] || 0);

  // Label logic
  let label;
  if (selectedSport === "all") label = "Activity Frequency";
  else if (["Ride","Hike","GravelRide"].includes(selectedSport)) label = "Elevation Gained (m)";
  else if (["Run","Walk"].includes(selectedSport)) label = "Distance (km)";
  else if (["StandUpPaddling","Snowboard"].includes(selectedSport)) label = "Moving Time (hours)";
  else label = selectedSport;

  const displayData = data.map(value => {
    if (["Run","Walk"].includes(selectedSport)) return (value / 1000).toFixed(1);
    if (["StandUpPaddling","Snowboard"].includes(selectedSport)) return (value / 3600).toFixed(1);
    return value;
  });

  if (!chart) {
    const ctx = document.getElementById('activityChart').getContext('2d');
    chart = new Chart(ctx, {
      type: 'bar',
      data: { labels: months, datasets: [{ label, data: displayData, backgroundColor: '#ff8f5fff', borderColor: '#e14a09ff', borderWidth: 2 }] },
      options: { responsive: true, scales: { y: { beginAtZero: true } } }
    });
  } else {
    chart.data.datasets[0].label = label;
    chart.data.datasets[0].data = displayData;
    chart.update();
  }
}

//------------------ Add Map Move Event ------------------//
map.on('moveend', () => {
  const bounds = map.getBounds();
  updateChart(sportFilter.value, bounds);
});

//------------------ Filter Listener (unchanged) ------------------//
sportFilter.addEventListener('change', function() {
  updateMap(this.value);
  updateChart(this.value, map.getBounds());
});

const modal = document.getElementById('welcomeModal');
  const closeBtn = document.getElementById('closeModal');

  // Close modal on button click
  closeBtn.addEventListener('click', () => {
    modal.style.display = 'none';
  });

  // close modal if user clicks outside the content
  window.addEventListener('click', (e) => {
    if(e.target === modal) {
      modal.style.display = 'none';
    }
  });