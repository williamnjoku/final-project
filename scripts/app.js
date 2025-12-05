import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    setDoc, 
    getDoc, 
    collection,
    addDoc, 
    deleteDoc, 
    onSnapshot, 
    query 
} from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";


const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';
const firebaseConfig = JSON.parse(typeof __firebase_config !== 'undefined' ? __firebase_config : '{}');
const initialAuthToken = typeof __initial_auth_token !== 'undefined' ? __initialAuthToken : null;

const API_URL = "https://api.frankfurter.app";
const API_BASE_CURRENCY = "USD"; 

let db;
let auth;
let userId = null;
let isAuthReady = false;
let currencyRates = {}; 
let isOfflineMode = false;
let hasRatesLoaded = false; 
let favoritesMap = new Map();

const CURRENCIES = [
    { code: "USD", name: "US Dollar" },
    { code: "EUR", name: "Euro" },
    { code: "GBP", name: "British Pound" },
    { code: "NGN", name: "Nigerian Naira" },
    { code: "JPY", name: "Japanese Yen" },
    { code: "CAD", name: "Canadian Dollar" },
    { code: "AUD", name: "Australian Dollar" },
    { code: "ZAR", name: "South African Rand" },
    { code: "INR", name: "Indian Rupee" },
];

const CACHE_DOC_PATH = `/artifacts/${appId}/public/data/cache/rates`;

function getFavoritesCollectionRef() {
    if (!db || !userId) {
        throw new Error("Firestore or User ID not available.");
    }
    return collection(db, `artifacts/${appId}/users/${userId}/favorites`);
}

const $mainLayout = document.getElementById('main-layout'); 
const $loadingIndicator = document.getElementById('loading-indicator');
const $conversionCard = document.getElementById('conversion-card');
const $historicalWidget = document.getElementById('historical-widget');
const $fromCurrency = document.getElementById('from-currency');
const $toCurrency = document.getElementById('to-currency');
const $fromAmount = document.getElementById('from-amount');
const $rateDisplay = document.getElementById('rate-display');
const $totalDisplay = document.getElementById('total-display');
const $cachedStatus = document.getElementById('cached-status');
const $historicalRates = document.getElementById('historical-rates');
const $userDisplay = document.getElementById('user-display');
const $themeIcon = document.getElementById('theme-icon');
const $favoriteToggle = document.getElementById('favorite-toggle');
const $favoriteIcon = document.getElementById('favorite-icon');
const $favoritesList = document.getElementById('favorites-list');


function showAlert(message) {
    const alertElement = document.getElementById('app-alert');
    alertElement.textContent = message;
    alertElement.classList.remove('hidden');
    setTimeout(() => {
        alertElement.classList.add('hidden');
    }, 8000);
}

function getSelectedPair() {
    return {
        from: $fromCurrency.value,
        to: $toCurrency.value
    };
}

function setUILoaded() {
    $loadingIndicator.classList.add('hidden');
    $conversionCard.classList.remove('hidden');
    $historicalWidget.classList.remove('hidden');
}


async function saveRatesCache() {
    if (!db || Object.keys(currencyRates).length === 0) return;
    try {
        const ratesData = {
            rates: JSON.stringify(currencyRates),
            timestamp: new Date().toISOString(),
            base: API_BASE_CURRENCY
        };
        await setDoc(doc(db, CACHE_DOC_PATH), ratesData); 
        console.log("Rates cached successfully to Firestore.");
    } catch (error) {
        console.error("Error saving rates cache:", error);
    }
}

async function loadRatesCache() {
    if (!db) return false;
    try {
        const docSnap = await getDoc(doc(db, CACHE_DOC_PATH));
        if (docSnap.exists()) {
            const data = docSnap.data();
            currencyRates = JSON.parse(data.rates);
            isOfflineMode = true;
            $cachedStatus.classList.remove('hidden');
            showAlert(`Loaded exchange rates from cache (Last updated: ${new Date(data.timestamp).toLocaleTimeString()}).`);
            return true;
        }
    } catch (error) {
        console.error("Error loading rates cache:", error);
    }
    return false;
}

async function fetchRates(base = API_BASE_CURRENCY, retries = 3) {
    const url = `${API_URL}/latest?from=${base}`;
    isOfflineMode = false;
    $cachedStatus.classList.add('hidden');

    for (let i = 0; i < retries; i++) {
        try {
            const response = await fetch(url);
            if (!response.ok) throw new Error(`HTTP error! Status: ${response.status}`);
            const data = await response.json();

            currencyRates = data.rates;
            currencyRates[data.base] = 1; 
            hasRatesLoaded = true; 

            console.log(`Rates fetched successfully for base: ${data.base}`);

            await saveRatesCache();
            return true;
        } catch (error) {
            console.warn(`Attempt ${i + 1} failed to fetch live rates: ${error.message}`);
            if (i === retries - 1) {
                console.error("Failed to fetch live rates. Attempting to load cache.");
                const cacheLoaded = await loadRatesCache();
                if (cacheLoaded) {
                    hasRatesLoaded = true;
                } else {
                    showAlert("Critical error: Cannot load live rates or cache. Check API/Internet.");
                    hasRatesLoaded = false;
                }
                return cacheLoaded;
            }

            const delay = Math.pow(2, i) * 1000;
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    return false;
}

async function fetchHistoricalRates(from, to, days = 7) {
    if (!hasRatesLoaded || isOfflineMode) {
         $historicalRates.innerHTML = `<p class="text-sm text-gray-500 dark:text-gray-400">Historical data requires a live connection.</p>`;
         return;
    }

    const endDate = new Date().toISOString().split('T')[0];
    const startDate = new Date(Date.now() - (days * 24 * 60 * 60 * 1000)).toISOString().split('T')[0];

    const url = `${API_URL}/${startDate}..${endDate}?from=${from}&to=${to}`; // Use date range endpoint

    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Historical data error! Status: ${response.status}`);
        const data = await response.json();

        if (!data.rates || Object.keys(data.rates).length === 0) {
            $historicalRates.innerHTML = `<p class="text-sm text-yellow-600 dark:text-yellow-400">No historical data found for the selected pair.</p>`;
            return;
        }

        let rates = [];
        for (const date in data.rates) {
            if (data.rates[date][to]) {
                rates.push({ date, rate: data.rates[date][to] });
            }
        }
        
        rates.sort((a, b) => new Date(a.date) - new Date(b.date));

        if (rates.length < 2) {
             $historicalRates.innerHTML = `<p class="text-sm text-yellow-600 dark:text-yellow-400">Not enough data points (${rates.length}) to show a meaningful trend.</p>`;
             return;
        }

        const startRate = rates[0].rate;
        const endRate = rates[rates.length - 1].rate;
        const change = endRate - startRate;
        const percentageChange = ((change / startRate) * 100).toFixed(2);

        const trendText = change > 0
            ? `<span class="text-accent font-semibold">Increased</span>`
            : change < 0
            ? `<span class="text-red-500 font-semibold">Decreased</span>`
            : `**Remained Stable**`;

        $historicalRates.innerHTML = `
            <p class="text-base font-semibold mb-2">Trend for ${from} to ${to} (${rates.length} days):</p>
            <ul class="list-disc ml-4 text-sm dark:text-gray-300">
                <li>Start Rate (${rates[0].date}): 1 ${from} = ${startRate.toFixed(4)} ${to}</li>
                <li>End Rate (${rates[rates.length - 1].date}): 1 ${from} = ${endRate.toFixed(4)} ${to}</li>
                <li class="${change >= 0 ? 'text-accent' : 'text-red-500'}">
                    Overall, the rate has ${trendText} by ${Math.abs(percentageChange)}%.
                </li>
            </ul>
        `;

    } catch (error) {
        console.error("Error fetching historical rates:", error);
        $historicalRates.innerHTML = `<p class="text-sm text-red-500 dark:text-red-400">Error retrieving historical data. API limit or error.</p>`;
    }
}

function updateConversion() {
    if (!hasRatesLoaded) {
         showAlert("Still loading rates. Please wait a moment.");
         return;
    }

    const amount = parseFloat($fromAmount.value);
    const { from: fromCurrency, to: toCurrency } = getSelectedPair();

    if (isNaN(amount) || amount <= 0) {
        if ($fromAmount.value.trim() !== "") {
            showAlert("Please enter a valid amount.");
        }
        $totalDisplay.textContent = "0.00";
        return;
    }

    if (!currencyRates[fromCurrency] || !currencyRates[toCurrency]) {
        showAlert(`Cannot convert: The exchange rate for ${fromCurrency} or ${toCurrency} is missing from the API data. This is likely a temporary API issue.`);
        $totalDisplay.textContent = "0.00";
        return;
    }

    const baseValue = amount / currencyRates[fromCurrency];
    const result = baseValue * currencyRates[toCurrency];

    const rate = currencyRates[toCurrency] / currencyRates[fromCurrency];

    $rateDisplay.textContent = `1 ${fromCurrency} = ${rate.toFixed(4)} ${toCurrency}`;
    $totalDisplay.textContent = result.toFixed(2);

    updateFavoriteIcon(fromCurrency, toCurrency);

    if (!isOfflineMode) {
        fetchHistoricalRates(fromCurrency, toCurrency);
    } else {
         $historicalRates.innerHTML = `<p class="text-sm text-gray-500 dark:text-gray-400">Historical data requires a live connection.</p>`;
    }
}

function switchCurrencies() {
    const temp = $fromCurrency.value;
    $fromCurrency.value = $toCurrency.value;
    $toCurrency.value = temp;

    const switchButton = document.getElementById('switch-currency');
    switchButton.classList.add('animate-swap');
    setTimeout(() => {
        switchButton.classList.remove('animate-swap');
    }, 500);

    updateConversion();
}

function listenForFavorites() {
            if (!isAuthReady || !userId || !db) return;

            try {
                const favoritesRef = getFavoritesCollectionRef();
                const q = query(favoritesRef);

                onSnapshot(q, (snapshot) => {
                    $favoritesList.innerHTML = '';
                    favoritesMap.clear();

                    if (snapshot.empty) {
                        $favoritesList.innerHTML = '<li class="text-gray-500 dark:text-gray-400">No favorite pairs saved yet.</li>';
                        updateFavoriteIcon($fromCurrency.value, $toCurrency.value); 
                        return;
                    }

                    snapshot.forEach(doc => {
                        const data = doc.data();
                        const pair = `${data.from}/${data.to}`;
                        favoritesMap.set(pair, doc.id); 

                        const li = document.createElement('li');
                        li.className = 'flex justify-between items-center text-gray-700 dark:text-gray-200 p-2 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors cursor-pointer';
                        
                        const pairSpan = document.createElement('span');
                        pairSpan.className = 'font-semibold text-primary-action';
                        pairSpan.textContent = pair;
                        
                        const deleteBtn = document.createElement('span');
                        deleteBtn.className = 'text-red-500 cursor-pointer hover:text-red-700 transition-colors ml-4';
                        deleteBtn.innerHTML = '<svg class="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>';
                        deleteBtn.onclick = (e) => {
                            e.stopPropagation();
                            deleteFavoritePair(doc.id, pair);
                        };
                        
                        li.onclick = () => loadFavoritePair(data.from, data.to);

                        li.appendChild(pairSpan);
                        li.appendChild(deleteBtn);
                        $favoritesList.appendChild(li);
                    });

                    updateFavoriteIcon($fromCurrency.value, $toCurrency.value);
                });
            } catch (error) {
                showAlert('Error loading favorites: ' + error.message, true);
            }
        }

        function loadFavoritePair(from, to) {
            $fromCurrency.value = from;
            $toCurrency.value = to;
            updateConversion();
            showAlert(`Loaded favorite pair: ${from}/${to}`, false);
        }

        async function toggleFavorite() {
            if (!isAuthReady || !userId || !db) {
                showAlert("Please wait for authentication to complete before saving favorites.", true);
                return;
            }
            
            const { from: fromCode, to: toCode } = getSelectedPair();
            const pair = `${fromCode}/${toCode}`;

            if (favoritesMap.has(pair)) {
                const docId = favoritesMap.get(pair);
                await deleteFavoritePair(docId, pair);
            } else {
                await saveFavoritePair(fromCode, toCode, pair);
            }
        }

        async function saveFavoritePair(from, to, pair) {
            try {
                await addDoc(getFavoritesCollectionRef(), {
                    from: from,
                    to: to,
                    createdAt: new Date().toISOString()
                });
                showAlert(`'${pair}' added to favorites!`, false);
            } catch (error) {
                showAlert(`Failed to save favorite: ${error.message}`, true);
                console.error("Save favorite error:", error);
            }
        }

        async function deleteFavoritePair(docId, pair) {
            try {
                await deleteDoc(doc(getFavoritesCollectionRef(), docId));
                showAlert(`'${pair}' removed from favorites.`, false);
            } catch (error) {
                showAlert(`Failed to remove favorite: ${error.message}`, true);
                console.error("Delete favorite error:", error);
            }
        }

        const OUTLINE_STAR = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z"/>`;
        const FILLED_STAR = `<path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14l-5-4.87 6.91-1.01L12 2z" fill="currentColor"/>`;

    function updateFavoriteIcon(from, to) {
    const pair = `${from}/${to}`;
    const isFavorite = favoritesMap.has(pair);
    
    $favoriteIcon.innerHTML = isFavorite ? FILLED_STAR : OUTLINE_STAR;
    
    $favoriteIcon.classList.remove('text-gray-400', 'dark:text-gray-500', 'text-yellow-500', 'hover:text-yellow-600', 'fill-current');
    
    if (isFavorite) {
        $favoriteIcon.classList.add('text-yellow-500', 'hover:text-yellow-600', 'fill-current');
        $favoriteIcon.setAttribute('stroke', 'none'); 
        $favoriteIcon.setAttribute('fill', 'currentColor'); 
    } else {
        $favoriteIcon.classList.add('text-gray-400', 'dark:text-gray-500');
        $favoriteIcon.setAttribute('stroke', 'currentColor'); 
        $favoriteIcon.setAttribute('fill', 'none'); 
    }
}
       

const SUN_SVG = `<path d="M12 2v2"/><path d="M12 20v2"/><path d="M4.93 4.93l1.41 1.41"/><path d="M17.66 17.66l1.41 1.41"/><path d="M2 12h2"/><path d="M20 12h2"/><path d="M4.93 19.07l1.41-1.41"/><path d="M17.66 6.34l1.41-1.41"/><circle cx="12" cy="12" r="4"/>`;
const MOON_SVG = `<path d="M12 3a6 6 0 009 9 9 9 0 11-9-9Z"/>`;


function populateDropdowns() {
    CURRENCIES.forEach(currency => {
        const optionFrom = document.createElement('option');
        optionFrom.value = currency.code;
        optionFrom.textContent = `${currency.code} - ${currency.name}`;
        $fromCurrency.appendChild(optionFrom);

        const optionTo = optionFrom.cloneNode(true);
        $toCurrency.appendChild(optionTo);
    });

    $fromCurrency.value = "USD";
    $toCurrency.value = "NGN";
}

function setupThemeToggle() {
            const body = document.body;

            const updateIconAttributes = (isDarkMode) => {
                $themeIcon.setAttribute('viewBox', '0 0 24 24'); 
                
                if (isDarkMode) {
                    $themeIcon.innerHTML = SUN_SVG;
                    $themeIcon.setAttribute('fill', 'none'); 
                    $themeIcon.setAttribute('stroke', 'currentColor');
                    $themeIcon.setAttribute('stroke-width', '2'); 
                    $themeIcon.setAttribute('stroke-linecap', 'round');
                    $themeIcon.setAttribute('stroke-linejoin', 'round');
                } 
                else { 
                    $themeIcon.innerHTML = MOON_SVG;
                    $themeIcon.setAttribute('fill', 'currentColor');
                    $themeIcon.setAttribute('stroke', 'none');
                }
            }

            const isDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
            if (isDark && !body.classList.contains('dark-mode')) {
                body.classList.replace('light-mode', 'dark-mode');
            }
            updateIconAttributes(body.classList.contains('dark-mode'));

            document.getElementById('theme-toggle').addEventListener('click', () => {
                const isCurrentlyDark = body.classList.contains('dark-mode');

                if (isCurrentlyDark) {
                    body.classList.replace('dark-mode', 'light-mode');
                    updateIconAttributes(false); 
                } else {
                    body.classList.replace('light-mode', 'dark-mode');
                    updateIconAttributes(true); 
                }
            });
        }


async function initFirebase() {
    try {
        if (Object.keys(firebaseConfig).length === 0) {
            console.warn("Firebase config is empty. Proceeding with API features only.");
            await fetchRatesAndInitialize();
            isAuthReady = true;
            setUILoaded();
            return;
        }

        const app = initializeApp(firebaseConfig);
        db = getFirestore(app);
        auth = getAuth(app);

        if (initialAuthToken) {
            await signInWithCustomToken(auth, initialAuthToken);
        } else {
            await signInAnonymously(auth);
        }

        onAuthStateChanged(auth, async (user) => {
            if (user) {
                userId = user.uid;
                $userDisplay.textContent = `User: ${userId.substring(0, 8)}...`;
                console.log("Authenticated user:", userId);
            } else {
                userId = null;
                $userDisplay.textContent = 'User: Anon';
                console.log("User is unauthenticated.");
            }
            isAuthReady = true;

            await fetchRatesAndInitialize();
            listenForFavorites();
            setUILoaded();
        });

    } catch (error) {
        console.error("Error initializing Firebase or signing in:", error);
        showAlert("Application failed to initialize database features. Functioning in API-only mode.");
        isAuthReady = true;
        await fetchRatesAndInitialize();
        setUILoaded();
    }
}

async function fetchRatesAndInitialize() {
    if (hasRatesLoaded) return; 
    const success = await fetchRates(API_BASE_CURRENCY);

    if (success) {
        updateConversion();
    }
}

function setupEventListeners() {
    document.getElementById('switch-currency').addEventListener('click', switchCurrencies);
    $fromAmount.addEventListener('input', updateConversion);
    $fromCurrency.addEventListener('change', updateConversion);
    $toCurrency.addEventListener('change', updateConversion);
    $favoriteToggle.addEventListener('click', toggleFavorite);
}

function init() {
    populateDropdowns();
    setupThemeToggle();
    setupEventListeners();
    initFirebase();
}

window.onload = init;


