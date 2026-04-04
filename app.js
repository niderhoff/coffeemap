// CoffeeMap - Mobile-first OpenStreetMap coffee shop finder

(function () {
  'use strict';

  // --- State ---
  let map;
  let userMarker;
  let userLatLng = null;
  let shopMarkers = [];
  let activeMarker = null;
  let searchAbort = null;

  // --- DOM refs ---
  const $map = document.getElementById('map');
  const $searchInput = document.getElementById('search-input');
  const $btnSearch = document.getElementById('btn-search');
  const $btnMenu = document.getElementById('btn-menu');
  const $btnLocate = document.getElementById('btn-locate');
  const $sidebar = document.getElementById('sidebar');
  const $overlay = document.getElementById('sidebar-overlay');
  const $btnCloseSidebar = document.getElementById('btn-close-sidebar');
  const $detail = document.getElementById('shop-detail');
  const $btnCloseDetail = document.getElementById('btn-close-detail');
  const $btnDirections = document.getElementById('btn-directions');
  const $loading = document.getElementById('loading');
  const $filterCafe = document.getElementById('filter-cafe');
  const $filterEspresso = document.getElementById('filter-espresso');
  const $filterRoastery = document.getElementById('filter-roastery');
  const $filterWifi = document.getElementById('filter-wifi');

  // --- Coffee icon ---
  function createCoffeeIcon(active) {
    return L.divIcon({
      className: '',
      html: '<div class="coffee-marker' + (active ? ' coffee-marker-active' : '') + '"><span>&#9749;</span></div>',
      iconSize: active ? [38, 38] : [32, 32],
      iconAnchor: active ? [19, 38] : [16, 32],
      popupAnchor: [0, -32],
    });
  }

  const userIcon = L.divIcon({
    className: '',
    html: '<div class="user-location"></div>',
    iconSize: [16, 16],
    iconAnchor: [8, 8],
  });

  // --- Init map ---
  function initMap() {
    map = L.map($map, {
      zoomControl: true,
      attributionControl: true,
      tap: true,
    }).setView([40.7128, -74.006], 14); // Default: NYC

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19,
    }).addTo(map);

    // Load shops on move
    let moveTimer;
    map.on('moveend', function () {
      clearTimeout(moveTimer);
      moveTimer = setTimeout(fetchCoffeeShops, 600);
    });

    // Close detail on map click
    map.on('click', function () {
      closeDetail();
    });

    // Initial locate
    locateUser(true);
  }

  // --- Geolocation ---
  function locateUser(initial) {
    if (!navigator.geolocation) return;

    navigator.geolocation.getCurrentPosition(
      function (pos) {
        userLatLng = [pos.coords.latitude, pos.coords.longitude];

        if (userMarker) {
          userMarker.setLatLng(userLatLng);
        } else {
          userMarker = L.marker(userLatLng, { icon: userIcon, zIndexOffset: 1000 }).addTo(map);
        }

        if (initial) {
          map.setView(userLatLng, 15);
        } else {
          map.flyTo(userLatLng, 16, { duration: 0.8 });
        }
      },
      function () {
        // Geolocation denied/failed — just use default view and fetch
        if (initial) fetchCoffeeShops();
      },
      { enableHighAccuracy: true, timeout: 8000 }
    );
  }

  // --- Simple cache: skip fetch if viewport is still inside last fetched area ---
  var lastFetchBounds = null;  // padded bounds of last successful fetch
  var lastFilterKey = '';       // filter settings that produced lastFetchBounds
  var CACHE_TTL = 5 * 60 * 1000;
  var lastFetchTime = 0;

  function getFilterKey() {
    return ($filterCafe.checked ? 'c' : '') +
           ($filterEspresso.checked ? 'e' : '') +
           ($filterRoastery.checked ? 'r' : '') +
           ($filterWifi.checked ? 'w' : '');
  }

  function invalidateCache() {
    lastFetchBounds = null;
    lastFilterKey = '';
  }

  // --- Overpass API: fetch coffee shops ---
  function fetchCoffeeShops() {
    const bounds = map.getBounds();
    var filterKey = getFilterKey();

    // Skip fetch if viewport is still within the last fetched (padded) area
    // and filters haven't changed and cache hasn't expired
    if (lastFetchBounds && filterKey === lastFilterKey &&
        lastFetchBounds.contains(bounds) &&
        Date.now() - lastFetchTime < CACHE_TTL) {
      return;
    }

    // Pad bounds by 30% so small pans reuse this fetch
    var padded = bounds.pad(0.3);
    const south = padded.getSouth().toFixed(6);
    const west = padded.getWest().toFixed(6);
    const north = padded.getNorth().toFixed(6);
    const east = padded.getEast().toFixed(6);
    const bbox = south + ',' + west + ',' + north + ',' + east;

    // Build filter from checkboxes — exclude obvious non-coffee places
    var wifi = $filterWifi.checked ? '["internet_access"~"wlan|yes"]' : '';
    const filters = [];
    if ($filterCafe.checked) {
      filters.push('node["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]'+wifi+'('+bbox+');');
      filters.push('way["amenity"="cafe"]["cuisine"!~"ice_cream|bar|pub|pizza|burger|sandwich"]'+wifi+'('+bbox+');');
    }
    if ($filterEspresso.checked) {
      filters.push('node["cuisine"~"coffee|coffee_shop"]'+wifi+'('+bbox+');');
      filters.push('way["cuisine"~"coffee|coffee_shop"]'+wifi+'('+bbox+');');
    }
    if ($filterRoastery.checked) {
      filters.push('node["craft"="roastery"]'+wifi+'('+bbox+');');
      filters.push('way["craft"="roastery"]'+wifi+'('+bbox+');');
    }

    if (filters.length === 0) {
      clearMarkers();
      invalidateCache();
      return;
    }

    const query = '[out:json][timeout:15];(' + filters.join('') + ');out center 80;';

    if (searchAbort) searchAbort.abort();
    searchAbort = new AbortController();

    showLoading();

    fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query), {
      signal: searchAbort.signal,
    })
      .then(function (res) { return res.json(); })
      .then(function (data) {
        hideLoading();
        var elements = data.elements || [];
        lastFetchBounds = padded;
        lastFilterKey = filterKey;
        lastFetchTime = Date.now();
        renderShops(elements);
      })
      .catch(function (err) {
        hideLoading();
        if (err.name !== 'AbortError') {
          console.error('Overpass fetch error:', err);
        }
      });
  }

  // --- Render shop markers ---
  function renderShops(elements) {
    clearMarkers();

    const seen = new Set();

    elements.forEach(function (el) {
      const lat = el.lat || (el.center && el.center.lat);
      const lon = el.lon || (el.center && el.center.lon);
      if (!lat || !lon) return;

      const key = lat.toFixed(5) + ',' + lon.toFixed(5);
      if (seen.has(key)) return;
      seen.add(key);

      const marker = L.marker([lat, lon], { icon: createCoffeeIcon(false) }).addTo(map);
      marker._shopData = el.tags || {};
      marker._shopData._lat = lat;
      marker._shopData._lon = lon;

      marker.on('click', function (e) {
        L.DomEvent.stopPropagation(e);
        selectShop(marker);
      });

      shopMarkers.push(marker);
    });
  }

  function clearMarkers() {
    shopMarkers.forEach(function (m) { map.removeLayer(m); });
    shopMarkers = [];
    activeMarker = null;
  }

  // --- Select / detail ---
  function selectShop(marker) {
    // Reset previous
    if (activeMarker) {
      activeMarker.setIcon(createCoffeeIcon(false));
    }

    activeMarker = marker;
    marker.setIcon(createCoffeeIcon(true));

    const d = marker._shopData;

    // Photo: try image tag, then wikimedia_commons
    var $photoWrap = document.getElementById('detail-photo-wrap');
    var $photo = document.getElementById('detail-photo');
    var photoUrl = getPhotoUrl(d);
    if (photoUrl) {
      $photo.src = photoUrl;
      $photo.onerror = function () { $photoWrap.classList.add('hidden'); };
      $photoWrap.classList.remove('hidden');
    } else {
      $photoWrap.classList.add('hidden');
      $photo.src = '';
    }

    document.getElementById('detail-name').textContent = d.name || 'Coffee Shop';
    document.getElementById('detail-cuisine').textContent = d.cuisine ? 'Cuisine: ' + d.cuisine : '';
    document.getElementById('detail-address').textContent = formatAddress(d);
    document.getElementById('detail-hours').textContent = d.opening_hours ? 'Hours: ' + d.opening_hours : '';
    document.getElementById('detail-phone').textContent = d.phone ? 'Phone: ' + d.phone : '';
    document.getElementById('detail-wifi').textContent =
      (d.internet_access === 'wlan' || d.internet_access === 'yes') ? 'WiFi: Yes' : '';

    const $website = document.getElementById('detail-website');
    if (d.website) {
      $website.innerHTML = 'Website: <a href="' + escapeHtml(d.website) + '" target="_blank" rel="noopener">' + escapeHtml(truncate(d.website, 40)) + '</a>';
    } else {
      $website.textContent = '';
    }

    // Store lat/lon for directions
    $btnDirections._lat = d._lat;
    $btnDirections._lon = d._lon;

    $detail.classList.remove('hidden');
  }

  function formatAddress(tags) {
    const parts = [];
    if (tags['addr:street']) {
      let addr = '';
      if (tags['addr:housenumber']) addr += tags['addr:housenumber'] + ' ';
      addr += tags['addr:street'];
      parts.push(addr);
    }
    if (tags['addr:city']) parts.push(tags['addr:city']);
    return parts.length > 0 ? parts.join(', ') : '';
  }

  function closeDetail() {
    $detail.classList.add('hidden');
    if (activeMarker) {
      activeMarker.setIcon(createCoffeeIcon(false));
      activeMarker = null;
    }
  }

  // --- Search (geocode + re-center) ---
  function doSearch() {
    const q = $searchInput.value.trim();
    if (!q) return;

    $searchInput.blur(); // Close mobile keyboard

    showLoading();
    fetch('https://nominatim.openstreetmap.org/search?format=json&q=' + encodeURIComponent(q) + '&limit=1', {
      headers: { 'Accept-Language': 'en' },
    })
      .then(function (res) { return res.json(); })
      .then(function (results) {
        hideLoading();
        if (results.length > 0) {
          const r = results[0];
          invalidateCache();
          map.once('moveend', function () { fetchCoffeeShops(); });
          map.flyTo([parseFloat(r.lat), parseFloat(r.lon)], 15, { duration: 1 });
        }
      })
      .catch(function () {
        hideLoading();
      });
  }

  // --- Sidebar ---
  function openSidebar() {
    $sidebar.classList.remove('hidden');
    $overlay.classList.remove('hidden');
  }

  function closeSidebar() {
    $sidebar.classList.add('hidden');
    $overlay.classList.add('hidden');
  }

  // --- Loading ---
  function showLoading() { $loading.classList.remove('hidden'); }
  function hideLoading() { $loading.classList.add('hidden'); }

  // --- Helpers ---
  function escapeHtml(str) {
    var div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
  }

  function truncate(str, len) {
    return str.length > len ? str.substring(0, len) + '...' : str;
  }

  function getPhotoUrl(tags) {
    // Direct image URL
    if (tags.image) {
      return tags.image;
    }
    // Wikimedia Commons file name → thumbnail URL
    if (tags.wikimedia_commons) {
      var file = tags.wikimedia_commons.replace(/^File:/, '').replace(/ /g, '_');
      return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=400';
    }
    // Wikidata ID → use wikidata thumbnail API
    if (tags.wikidata) {
      return null; // would need async fetch, skip for now
    }
    return null;
  }

  // --- Event listeners ---
  $btnMenu.addEventListener('click', openSidebar);
  $btnCloseSidebar.addEventListener('click', closeSidebar);
  $overlay.addEventListener('click', closeSidebar);
  $btnLocate.addEventListener('click', function () { locateUser(false); });
  $btnCloseDetail.addEventListener('click', closeDetail);
  $btnSearch.addEventListener('click', doSearch);
  $searchInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') doSearch();
  });

  // Directions button opens external maps
  $btnDirections.addEventListener('click', function () {
    var lat = this._lat;
    var lon = this._lon;
    // Try native maps on mobile, fallback to OSM
    var url = 'https://www.openstreetmap.org/directions?from=&to=' + lat + ',' + lon;
    window.open(url, '_blank');
  });

  // Filter changes trigger refetch
  [$filterCafe, $filterEspresso, $filterRoastery, $filterWifi].forEach(function (cb) {
    cb.addEventListener('change', fetchCoffeeShops);
  });

  // Prevent pull-to-refresh on mobile
  document.body.addEventListener('touchmove', function (e) {
    if (e.target.closest('#sidebar-content') || e.target.closest('#shop-detail')) return;
    if (e.target.closest('#map')) return;
  }, { passive: true });

  // --- Start ---
  initMap();
})();
