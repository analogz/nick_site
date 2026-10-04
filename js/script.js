const themeToggle = document.getElementById('theme-toggle');
const themeQuery = window.matchMedia('(prefers-color-scheme: dark)');

function themeIsDark() {
    const choice = document.documentElement.dataset.theme;
    if (choice === 'dark') return true;
    if (choice === 'light') return false;
    return themeQuery.matches;
}

function syncThemeToggle() {
    if (!themeToggle) return;
    const dark = themeIsDark();
    themeToggle.textContent = dark ? 'Light' : 'Dark';
    themeToggle.setAttribute('aria-pressed', String(dark));
    themeToggle.setAttribute('aria-label', dark ? 'Switch to light mode' : 'Switch to dark mode');
}

syncThemeToggle();

if (themeToggle) {
    themeToggle.addEventListener('click', () => {
        const next = themeIsDark() ? 'light' : 'dark';
        try { localStorage.setItem('theme', next); } catch (e) {}
        document.documentElement.dataset.theme = next;
        syncThemeToggle();
        window.dispatchEvent(new Event('themechange'));
    });
}

themeQuery.addEventListener('change', () => {
    if (!document.documentElement.dataset.theme) {
        syncThemeToggle();
        window.dispatchEvent(new Event('themechange'));
    }
});

document.querySelectorAll('.copyright-year').forEach(el => {
    el.textContent = new Date().getFullYear();
});

fetch('data/metrics.json')
    .then(r => r.json())
    .then(data => {
        const set = (key, val) => {
            document.querySelectorAll(`#metric-${key}, [data-metric="${key}"]`).forEach(el => { el.textContent = val; });
        };
        set('citations', data.citations.toLocaleString());
        set('hindex',    data.h_index);
        set('i10',       data.i10_index);
        if (data.publications != null) set('publications', data.publications.toLocaleString());
        if (data.patents != null) set('patents', data.patents.toLocaleString());
    })
    .catch(() => {});

// Smooth scroll for anchor links
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth',
                    block: 'start'
                });
            }
        });
    });
});

