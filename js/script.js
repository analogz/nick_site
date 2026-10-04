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

