document.querySelectorAll('.copyright-year').forEach(el => {
    el.textContent = new Date().getFullYear();
});

fetch('data/metrics.json')
    .then(r => r.json())
    .then(data => {
        const set = (id, val) => { const el = document.getElementById(id); if (el) el.textContent = val; };
        set('metric-citations', data.citations.toLocaleString());
        set('metric-hindex',    data.h_index);
        set('metric-i10',       data.i10_index);
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

