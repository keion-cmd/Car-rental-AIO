"use client";

import { FormEvent, useState } from "react";

const fleet = [
  {
    name: "Toyota Vios",
    type: "Compact sedan",
    price: "₱1,850",
    seats: "5 seats",
    transmission: "Automatic",
    accent: "sand",
    tag: "Best seller",
  },
  {
    name: "Toyota Innova",
    type: "Family MPV",
    price: "₱2,650",
    seats: "7 seats",
    transmission: "Automatic",
    accent: "blue",
    tag: "For groups",
  },
  {
    name: "Toyota Fortuner",
    type: "Premium SUV",
    price: "₱3,450",
    seats: "7 seats",
    transmission: "Automatic",
    accent: "green",
    tag: "Island ready",
  },
];

const locations = [
  { city: "Manila", detail: "Makati · NAIA pickup", code: "MNL" },
  { city: "Cebu", detail: "Cebu City · Mactan pickup", code: "CEB" },
];

export default function Home() {
  const [location, setLocation] = useState("Manila");
  const [differentReturn, setDifferentReturn] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  function handleSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitted(true);
    window.setTimeout(() => setSubmitted(false), 3500);
  }

  return (
    <main>
      <div className="announcement">
        <span className="announcement-dot" />
        <span>Now serving Manila and Cebu</span>
        <span className="announcement-divider" />
        <span>Reserve with a small deposit</span>
        <button aria-label="Close announcement">×</button>
      </div>

      <nav className="site-nav container">
        <a className="brand" href="#top" aria-label="Amihan Cars home">
          <span className="brand-mark">A</span>
          <span>
            <strong>amihan</strong>
            <small>CAR RENTALS</small>
          </span>
        </a>
        <div className="nav-links">
          <a href="#fleet">Our fleet</a>
          <a href="#locations">Locations</a>
          <a href="#how-it-works">How it works</a>
        </div>
        <div className="nav-actions">
          <a className="phone-link" href="tel:+63285550188">
            <span className="phone-icon">⌕</span> (02) 8555 0188
          </a>
          <a className="outline-button" href="#search">Find a car <span>↗</span></a>
        </div>
        <button className="menu-button" aria-label="Open menu">☰</button>
      </nav>

      <section className="hero" id="top">
        <div className="hero-orb orb-one" />
        <div className="hero-orb orb-two" />
        <div className="hero-grid" />
        <div className="container hero-content">
          <div className="hero-copy">
            <div className="eyebrow light"><span /> MADE FOR THE ROAD AHEAD</div>
            <h1>Your next<br /><em>good story</em><br />starts here.</h1>
            <p>Simple, reliable car rentals for city days, island escapes, and everything in between.</p>
            <div className="hero-proof">
              <div className="avatar-stack"><span>JM</span><span>AL</span><span>KR</span></div>
              <span>Trusted by <strong>2,000+ travelers</strong> this year</span>
            </div>
          </div>
          <div className="hero-visual" aria-label="Illustration of a white rental car">
            <div className="sun-disc" />
            <div className="mountain mountain-back" />
            <div className="mountain mountain-front" />
            <div className="road-line" />
            <div className="car-illustration">
              <div className="car-shadow" />
              <div className="car-body">
                <div className="car-window front-window" />
                <div className="car-window back-window" />
                <div className="car-hood" />
                <div className="car-light" />
                <div className="car-grille" />
              </div>
              <div className="wheel wheel-left"><span /></div>
              <div className="wheel wheel-right"><span /></div>
            </div>
            <div className="visual-label"><span>01</span><b>Drive your<br />own way</b></div>
          </div>
        </div>

        <div className="search-card container" id="search">
          <div className="search-heading">
            <span className="step-number">01</span>
            <div><strong>Find your ride</strong><small>Tell us when and where</small></div>
          </div>
          <form onSubmit={handleSearch}>
            <label className="field location-field">
              <span className="field-icon">⌖</span>
              <span className="field-label">PICKUP LOCATION</span>
              <select value={location} onChange={(event) => setLocation(event.target.value)}>
                {locations.map((item) => <option key={item.city}>{item.city}</option>)}
              </select>
            </label>
            <label className="field">
              <span className="field-icon">▣</span>
              <span className="field-label">PICKUP DATE</span>
              <input type="date" defaultValue="2026-10-12" />
            </label>
            <label className="field">
              <span className="field-icon">◷</span>
              <span className="field-label">PICKUP TIME</span>
              <select defaultValue="10:00 AM"><option>10:00 AM</option><option>12:00 PM</option><option>02:00 PM</option><option>04:00 PM</option></select>
            </label>
            <label className="field">
              <span className="field-icon">▣</span>
              <span className="field-label">RETURN DATE</span>
              <input type="date" defaultValue="2026-10-15" />
            </label>
            <label className="field">
              <span className="field-icon">◷</span>
              <span className="field-label">RETURN TIME</span>
              <select defaultValue="10:00 AM"><option>10:00 AM</option><option>12:00 PM</option><option>02:00 PM</option><option>04:00 PM</option></select>
            </label>
            <button className="search-button" type="submit">Search cars <span>→</span></button>
          </form>
          <label className="return-toggle"><input type="checkbox" checked={differentReturn} onChange={(event) => setDifferentReturn(event.target.checked)} /> Return to a different location</label>
          {differentReturn && <div className="return-location"><span>Drop-off location</span><select defaultValue={location === "Manila" ? "Cebu" : "Manila"}><option>Manila</option><option>Cebu</option></select></div>}
          {submitted && <div className="search-success">Great choice. We&apos;re checking available cars in {location} for your dates.</div>}
        </div>
      </section>

      <section className="trust-strip">
        <div className="container trust-items">
          <div><span className="trust-icon">✦</span><span><strong>Free cancellation</strong><small>Up to 48 hours before pickup</small></span></div>
          <div><span className="trust-icon">✓</span><span><strong>No hidden fees</strong><small>What you see is what you pay</small></span></div>
          <div><span className="trust-icon">⌁</span><span><strong>Local support</strong><small>Real people, 7 days a week</small></span></div>
          <div className="rating"><strong>4.9</strong><span className="stars">★★★★★</span><small>from 380+ reviews</small></div>
        </div>
      </section>

      <section className="section fleet-section" id="fleet">
        <div className="container">
          <div className="section-header"><div><div className="eyebrow"><span /> OUR FLEET</div><h2>Pick the one<br /><em>that fits.</em></h2></div><div className="section-intro"><p>From quick city runs to long weekends out of town, every car is clean, maintained, and ready when you are.</p><a href="#search" className="text-link">View all cars <span>↗</span></a></div></div>
          <div className="fleet-grid">{fleet.map((car) => <article className="fleet-card" key={car.name}><div className={`car-photo ${car.accent}`}><span className="fleet-tag">{car.tag}</span><div className="mini-car"><i /><b /><u /></div><span className="photo-caption">{car.type}</span></div><div className="fleet-details"><div><h3>{car.name}</h3><span>{car.type}</span></div><div className="price"><strong>{car.price}</strong><small> / day</small></div></div><div className="specs"><span>◉ {car.seats}</span><span>◌ {car.transmission}</span><span>⌁ Aircon</span></div></article>)}</div>
        </div>
      </section>

      <section className="story-section" id="how-it-works"><div className="container story-grid"><div className="story-photo"><div className="story-sun" /><div className="story-palms">♒</div><div className="story-card"><span>BUILT FOR<br />THE LONG WAY</span><strong>Since 2018</strong></div></div><div className="story-copy"><div className="eyebrow"><span /> WHY AMIHAN</div><h2>More than a<br /><em>rental car.</em></h2><p>We believe getting there should be part of the good stuff. That&apos;s why we keep things simple: dependable cars, honest prices, and a local team that knows the way.</p><div className="story-stats"><div><strong>2k+</strong><span>happy drivers</span></div><div><strong>4.9<span>/5</span></strong><span>average rating</span></div><div><strong>7</strong><span>days a week</span></div></div><a className="dark-button" href="#locations">Meet the team <span>→</span></a></div></div></section>

      <section className="locations-section" id="locations"><div className="container"><div className="section-header"><div><div className="eyebrow"><span /> COME FIND US</div><h2>Start anywhere.<br /><em>Go everywhere.</em></h2></div><p className="section-intro">Easy pickup in the places you&apos;re most likely to land, work, and wander.</p></div><div className="location-grid">{locations.map((item, index) => <a href="#search" className={`location-card location-${index}`} key={item.city}><span className="location-code">{item.code}</span><div><h3>{item.city}</h3><p>{item.detail}</p></div><span className="location-arrow">↗</span></a>)}</div></div></section>

      <footer><div className="container footer-top"><a className="brand footer-brand" href="#top"><span className="brand-mark">A</span><span><strong>amihan</strong><small>CAR RENTALS</small></span></a><div className="footer-quote">Take the scenic route.<br /><em>We&apos;ll handle the rest.</em></div><div className="footer-links"><a href="#fleet">Fleet</a><a href="#locations">Locations</a><a href="#how-it-works">About us</a><a href="mailto:hello@amihancars.ph">Contact</a></div></div><div className="container footer-bottom"><span>© 2026 Amihan Car Rentals</span><span>Made for the road ahead in the Philippines <b>✦</b></span><div><a href="#top">Privacy</a><a href="#top">Terms</a></div></div></footer>
    </main>
  );
}
