import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth, signInAnonymously, signInWithCustomToken, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { 
    getFirestore, 
    doc, 
    setDoc, 
    getDoc, 
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

const CACHE_DOC_PATH = `/artifacts/${appId}/public/data/cache/rates`;



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
        showAlert("Please enter a valid amount.");
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
            if (isDark) {
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
            } else {
                userId = null;
                $userDisplay.textContent = 'User: Anon';
            }
            isAuthReady = true;
            console.log(`User authenticated. Auth ready: ${isAuthReady}`);

            await fetchRatesAndInitialize();
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
}


function init() {
    populateDropdowns();
    setupThemeToggle();
    setupEventListeners();
    initFirebase();
}

window.onload = init;