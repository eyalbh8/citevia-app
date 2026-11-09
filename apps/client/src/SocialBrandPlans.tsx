import { Plus, Trash2 } from 'lucide-react';
import {
  MAX_SOCIAL_AUTOMATION_BRANDS, MAX_SOCIAL_AUTOMATION_SLOTS,
  type SocialAutomationBrand, type SocialAutomationSlot, type SocialDestination,
} from '@citevia/core';

const weekdays = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function PublishingTimes({ slots, onChange }: {
  slots: SocialAutomationSlot[]; onChange: (slots: SocialAutomationSlot[]) => void;
}) {
  function edit(id: string, changes: Partial<SocialAutomationSlot>) {
    onChange(slots.map(slot => slot.id === id ? { ...slot, ...changes } : slot));
  }
  return <div className="social-slots">{slots.map((slot, index) => <div key={slot.id} className="social-slot">
    <label className="field"><span>Day {index + 1}</span>
      <select aria-label={`Publishing day ${index + 1}`} value={slot.dayOfWeek} onChange={event => edit(slot.id, { dayOfWeek: Number(event.target.value) })}>
        {weekdays.map((day, dayOfWeek) => <option key={day} value={dayOfWeek}>{day}</option>)}
      </select></label>
    <label className="field"><span>Time</span><input type="time" aria-label={`Publishing time ${index + 1}`} value={slot.time} required onChange={event => edit(slot.id, { time: event.target.value })} /></label>
    <button type="button" className="icon-button" aria-label={`Remove publishing time ${index + 1}`} onClick={() => onChange(slots.filter(item => item.id !== slot.id))}><Trash2 size={17} /></button>
  </div>)}</div>;
}

function resizeBrandSchedule(slots: SocialAutomationSlot[], count: number, preparationTime: string) {
  const result = slots.slice(0, count);
  // Fill different days first, keeping every time the owner has already chosen.
  for (const time of ['09:00', '15:00', '12:00', '18:00', '11:00']) {
    for (const dayOfWeek of [1, 2, 3, 4, 5, 6, 0]) {
      if (result.length === count) return result;
      if (dayOfWeek === 1 && time <= preparationTime) continue;
      if (result.some(slot => slot.dayOfWeek === dayOfWeek && slot.time === time)) continue;
      result.push({ id: `slot_${crypto.randomUUID()}`, dayOfWeek, time });
    }
  }
  return result;
}

type Connection = Omit<SocialDestination, 'profileId'>;

export default function SocialBrandPlans({ brands, connections, generationTime, onChange }: {
  brands: SocialAutomationBrand[]; connections: Connection[]; generationTime: string; onChange: (brands: SocialAutomationBrand[]) => void;
}) {
  function edit(id: string, changes: Partial<SocialAutomationBrand>) {
    onChange(brands.map(brand => brand.id === id ? { ...brand, ...changes } : brand));
  }
  function addBrand() {
    onChange([...brands, {
      id: `brand_${crypto.randomUUID()}`, name: '', description: '', facebookDestinationId: '', instagramDestinationId: '',
      shareFacebookInstagramContent: false, slots: resizeBrandSchedule([], times < MAX_SOCIAL_AUTOMATION_SLOTS ? 1 : 0, generationTime),
    }]);
  }
  const times = brands.reduce((sum, brand) => sum + brand.slots.length, 0);
  const creatives = brands.reduce((sum, brand) => sum + brand.slots.length * (brand.shareFacebookInstagramContent ? 1 : 2), 0);
  const addButton = <button type="button" className="button button-outline" disabled={brands.length >= MAX_SOCIAL_AUTOMATION_BRANDS}
    onClick={addBrand}><Plus size={15} />Add brand</button>;
  return <section className="social-brand-plans" aria-label="Brand plans">
    <div className="social-schedule-heading">
      <div><h3>Brand plans</h3><p className="card-description">Give each product line its own Facebook and Instagram accounts and weekly publishing times.</p></div>
      {!brands.length && addButton}
    </div>
    {Boolean(brands.length) && <>
      <p className="social-help">Choose up to {MAX_SOCIAL_AUTOMATION_SLOTS} publishing times per week across all brands. Citevia uses only the selected accounts. Removing the last brand restores the project schedule when you save.</p>
      {(['facebook', 'instagram'] as const).some(channel => !connections.some(account => account.channel === channel && account.active && !account.requiresReconnect)) &&
        <p className="social-readiness">Connect a Facebook and an Instagram account for each brand in <a href="#integrations">Integrations</a>.</p>}
      {brands.map((brand, index) => {
        const name = brand.name.trim() || `Brand ${index + 1}`;
        return <fieldset key={brand.id} className="social-brand-plan">
          <legend>{name}</legend>
          <div className="social-brand-fields">
            <label className="field"><span>Brand name</span>
              <input value={brand.name} maxLength={100} required onChange={event => edit(brand.id, { name: event.target.value })} /></label>
            <label className="field"><span>What does this brand promote?</span>
              <textarea rows={2} maxLength={600} required value={brand.description} onChange={event => edit(brand.id, { description: event.target.value })} /></label>
            <div className="social-brand-accounts">{(['facebook', 'instagram'] as const).map(channel => {
              const field = channel === 'facebook' ? 'facebookDestinationId' : 'instagramDestinationId';
              const platform = channel === 'facebook' ? 'Facebook' : 'Instagram';
              const accounts = connections.filter(account => account.channel === channel);
              const selectedId = brand[field];
              return <label className="field" key={channel}><span>{platform} account</span>
                <select value={selectedId} required onChange={event => edit(brand.id, { [field]: event.target.value })}>
                  <option value="">Choose an account</option>
                  {selectedId && !accounts.some(account => account.id === selectedId) && <option value={selectedId} disabled>Unavailable account ({selectedId})</option>}
                  {accounts.map(account => {
                    const assigned = brands.find(other => other.id !== brand.id && other[field] === account.id);
                    const unavailable = !account.active || account.requiresReconnect;
                    const display = accounts.some(other => other.id !== account.id && other.username === account.username)
                      ? `${account.username} (${account.id})` : account.username;
                    return <option key={account.id} value={account.id} disabled={unavailable || Boolean(assigned)}>
                      {display}{unavailable ? ' · Reconnect required' : assigned ? ` · Assigned to ${assigned.name || 'another brand'}` : ''}
                    </option>;
                  })}
                </select></label>;
            })}</div>
            <label className="social-check"><input type="checkbox" checked={brand.shareFacebookInstagramContent} onChange={event => edit(brand.id, { shareFacebookInstagramContent: event.target.checked })} />
              <span><strong>Use the same post for Facebook and Instagram</strong><small>Prepare one caption and image for both selected accounts at each publishing time.</small></span></label>
            <label className="field social-weekly-volume"><span>Publishing times per week</span>
              <select value={brand.slots.length} onChange={event => edit(brand.id, { slots: resizeBrandSchedule(brand.slots, Number(event.target.value), generationTime) })}>
                {Array.from({ length: MAX_SOCIAL_AUTOMATION_SLOTS - times + brand.slots.length + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}
              </select></label>
            <PublishingTimes slots={brand.slots} onChange={slots => edit(brand.id, { slots })} />
            <button type="button" className="button button-outline" aria-label={`Remove ${name}`} onClick={() => onChange(brands.filter(other => other.id !== brand.id))}><Trash2 size={15} />Remove brand</button>
          </div>
        </fieldset>;
      })}
      {addButton}
      <p className="social-weekly-total" aria-live="polite"><strong>Weekly plan</strong> · {creatives} unique {creatives === 1 ? 'post' : 'posts'} · {times * 2} destination publications</p>
    </>}
  </section>;
}
