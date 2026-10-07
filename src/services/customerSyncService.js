// Customer (partner) sync — strictly one-way: T4A → CREAGLOBE.
//
// Unlike products, Metakocka partners have NO business key that is shared between the two
// companies: the partner `count_code` (šifra) and `mk_id` are per-company internal values and
// do NOT match across T4A and CREAGLOBE (measured: 0 count_code overlap). So we cannot do the
// clean `code`-keyed upsert that productSyncService does.
//
// Identity is therefore resolved with a two-tier match key:
//   1. tax_id_number (normalised)  — reliable for businesses that have one
//   2. exact normalised customer name — fallback for private consumers with no tax number
// A T4A partner that matches an existing CREAGLOBE partner is UPDATED (using CREAGLOBE's own
// mk_id); one that matches nothing is CREATED in CREAGLOBE.
//
// Nested contacts and delivery addresses are synced too. Because their mk_ids differ per
// company, we match them by a CONTENT SIGNATURE (type+street+post+city for addresses,
// name+email+phone for contacts) and only append the ones CREAGLOBE is missing — otherwise a
// blank-mk_id entry would make update_partner add a fresh duplicate on every single run.
//
// T4A is the single source of truth and is NEVER written to.

const axios = require("axios");
const config = require("../../config/config.json");

const COMPANY_ID_TO_NAME = {
    [process.env.MK_COMPANY_ID_T4A]: "T4A",
    [process.env.MK_COMPANY_ID_CREAGLOBE]: "CREAGLOBE"
};

// ── normalisation helpers ────────────────────────────────────────────────────

/** Tax numbers: strip whitespace, upper-case (e.g. "si 1234 5678" → "SI12345678"). */
function normTax(v) {
    return (v == null ? "" : String(v)).replace(/\s+/g, "").toUpperCase();
}

/** Generic string key: trim, lower-case, collapse internal whitespace. */
function normStr(v) {
    return (v == null ? "" : String(v)).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Real Metakocka data has a "provice" typo alongside "province" — accept either. */
function addrProvince(a) {
    return a.province != null ? a.province : a.provice;
}

/** Content signature for a delivery address (used to dedupe across companies). */
function addressSignature(a) {
    return [
        normStr(a.address_type || "Račun"),
        normStr(a.street),
        normStr(a.post_number),
        normStr(a.city)
    ].join("|");
}

/** Content signature for a contact (used to dedupe across companies). */
function contactSignature(c) {
    return [normStr(c.name), normStr(c.email), normStr(c.gsm || c.phone)].join("|");
}

// ── formatting ───────────────────────────────────────────────────────────────

/**
 * Normalises one get_partner record into the shape the merge logic works with.
 * The billing address ("Račun") lives in partner_delivery_address_list, not at the top level.
 */
function formatPartner(p) {
    const addresses = (p.partner_delivery_address_list || []).map((a) => ({
        mk_id: a.mk_id,
        address_type: a.address_type || "Račun",
        street: a.street,
        post_number: a.post_number,
        city: a.city,
        province: addrProvince(a),
        country: a.country
    }));
    // Prefer the "Račun" (billing) address; fall back to the first address present.
    const billing =
        addresses.find((a) => normStr(a.address_type).startsWith("ra")) || addresses[0] || null;

    const contacts = (p.partner_contact_list || []).map((c) => ({
        mk_id: c.mk_id,
        mk_address_id: c.mk_address_id,
        name: c.name,
        email: c.email,
        gsm: c.gsm,
        phone: c.phone,
        fax: c.fax
    }));

    return {
        mk_id: p.mk_id,
        count_code: p.count_code,
        customer: p.customer,
        business_entity: p.business_entity,
        taxpayer: p.taxpayer,
        foreign_county: p.foreign_county,
        buyer: p.buyer,
        supplier: p.supplier,
        tax_id_number: p.tax_id_number,
        registration_number: p.registration_number,
        billing,
        addresses,
        contacts
    };
}

// Top-level partner fields that are pushed T4A → CREAGLOBE on an existing match.
const TOP_LEVEL_FIELDS = [
    "customer",
    "tax_id_number",
    "registration_number",
    "business_entity",
    "taxpayer",
    "foreign_county",
    "buyer",
    "supplier"
];

/** Case-insensitive equality that treats null/undefined/"" as equal (missing == blank). */
function fieldEqual(a, b) {
    if (a == null || a === "") return b == null || b === "";
    return normStr(a) === normStr(b);
}

// ── match index ──────────────────────────────────────────────────────────────

/**
 * Indexes the CREAGLOBE partner list for lookup by tax number (primary) and normalised
 * name (fallback). First writer wins on collisions so the mapping is deterministic.
 */
function buildMatchIndex(creaglobePartners) {
    const byTax = new Map();
    const byName = new Map();
    for (const p of creaglobePartners) {
        const tax = normTax(p.tax_id_number);
        if (tax && !byTax.has(tax)) byTax.set(tax, p);
        const name = normStr(p.customer);
        if (name && !byName.has(name)) byName.set(name, p);
    }
    return { byTax, byName };
}

/** Finds the CREAGLOBE counterpart of a T4A partner, or null. */
function findMatch(t4aPartner, index) {
    const tax = normTax(t4aPartner.tax_id_number);
    if (tax && index.byTax.has(tax)) return { partner: index.byTax.get(tax), via: "tax" };
    const name = normStr(t4aPartner.customer);
    if (name && index.byName.has(name)) return { partner: index.byName.get(name), via: "name" };
    return null;
}

// ── payload builders ─────────────────────────────────────────────────────────

/** Drops undefined/null/"" keys so we never send empty strings that would blank a field. */
function pruneEmpty(obj) {
    return Object.fromEntries(Object.entries(obj).filter(([, v]) => v != null && v !== ""));
}

/**
 * Builds the add_partner payload for a T4A partner missing from CREAGLOBE. The billing address
 * goes at the top level (add_partner's convention); the primary contact and the first extra
 * delivery address are included inline. Remaining contacts/addresses are appended afterwards by
 * appendNested() (add_partner only documents a single contact + single delivery address).
 */
function buildCreatePayload(t4a) {
    const b = t4a.billing || t4a.addresses[0] || {};
    const partner = pruneEmpty({
        business_entity: t4a.business_entity != null ? t4a.business_entity : "false",
        taxpayer: t4a.taxpayer != null ? t4a.taxpayer : "false",
        foreign_county: t4a.foreign_county != null ? t4a.foreign_county : "false",
        buyer: t4a.buyer != null ? t4a.buyer : "true",
        supplier: t4a.supplier != null ? t4a.supplier : "false",
        tax_id_number: t4a.tax_id_number,
        registration_number: t4a.registration_number,
        customer: t4a.customer,
        street: b.street,
        post_number: b.post_number,
        place: b.city,
        province: b.province,
        country: b.country
    });

    const primary = t4a.contacts[0];
    if (primary) {
        const c = pruneEmpty({
            name: primary.name,
            email: primary.email,
            gsm: primary.gsm,
            phone: primary.phone,
            fax: primary.fax
        });
        if (Object.keys(c).length) partner.partner_contact = c;
    }

    // First delivery address that isn't the billing one goes inline with the create.
    const extraAddresses = t4a.addresses.filter((a) => a !== t4a.billing);
    if (extraAddresses[0]) {
        partner.partner_delivery_address = pruneEmpty({
            address_type: extraAddresses[0].address_type,
            street: extraAddresses[0].street,
            post_number: extraAddresses[0].post_number,
            city: extraAddresses[0].city,
            province: extraAddresses[0].province,
            country: extraAddresses[0].country
        });
    }

    return partner;
}

/**
 * Builds an update_partner payload that brings an existing CREAGLOBE partner in line with T4A:
 *   • top-level fields whose value differs,
 *   • billing/delivery addresses matched by signature (update by CREAGLOBE mk_id if changed,
 *     append if missing),
 *   • contacts matched by signature (append the ones CREAGLOBE is missing).
 * Returns null when nothing needs to change, so we don't fire no-op writes.
 */
function buildUpdatePayload(t4a, cg) {
    const partner = { mk_id: cg.mk_id };
    let changed = false;

    for (const field of TOP_LEVEL_FIELDS) {
        const v = t4a[field];
        if (v == null || v === "") continue;
        if (!fieldEqual(v, cg[field])) {
            partner[field] = v;
            changed = true;
        }
    }

    // ── addresses ──
    const addressList = [];

    // Billing (Račun) is reconciled BY ROLE, not by content signature: we update CREAGLOBE's
    // existing billing address in place (via its mk_id) so a name-matched partner whose billing
    // details differ doesn't end up with a second "Račun" address on the first sync.
    if (t4a.billing) {
        if (cg.billing) {
            const diff = pruneEmpty({
                street: !fieldEqual(t4a.billing.street, cg.billing.street) ? t4a.billing.street : undefined,
                post_number: !fieldEqual(t4a.billing.post_number, cg.billing.post_number) ? t4a.billing.post_number : undefined,
                city: !fieldEqual(t4a.billing.city, cg.billing.city) ? t4a.billing.city : undefined,
                province: !fieldEqual(t4a.billing.province, cg.billing.province) ? t4a.billing.province : undefined,
                country: !fieldEqual(t4a.billing.country, cg.billing.country) ? t4a.billing.country : undefined
            });
            if (Object.keys(diff).length) {
                addressList.push({ mk_id: cg.billing.mk_id, address_type: cg.billing.address_type || "Račun", ...diff });
                changed = true;
            }
        } else {
            // CREAGLOBE has no billing address at all → append T4A's.
            addressList.push(
                pruneEmpty({
                    address_type: "Račun",
                    street: t4a.billing.street,
                    post_number: t4a.billing.post_number,
                    city: t4a.billing.city,
                    province: t4a.billing.province,
                    country: t4a.billing.country
                })
            );
            changed = true;
        }
    }

    // Non-billing delivery addresses are matched by content signature: update the matched one if
    // province/country drifted, otherwise append the ones CREAGLOBE is missing.
    const cgNonBilling = cg.addresses.filter((a) => a !== cg.billing);
    const cgBySig = new Map(cgNonBilling.map((a) => [addressSignature(a), a]));
    for (const a of t4a.addresses) {
        if (a === t4a.billing) continue; // handled above
        const match = cgBySig.get(addressSignature(a));
        if (match) {
            const diff = pruneEmpty({
                province: !fieldEqual(a.province, match.province) ? a.province : undefined,
                country: !fieldEqual(a.country, match.country) ? a.country : undefined
            });
            if (Object.keys(diff).length) {
                addressList.push({ mk_id: match.mk_id, address_type: a.address_type, ...diff });
                changed = true;
            }
        } else {
            addressList.push(
                pruneEmpty({
                    address_type: a.address_type,
                    street: a.street,
                    post_number: a.post_number,
                    city: a.city,
                    province: a.province,
                    country: a.country
                })
            );
            changed = true;
        }
    }
    if (addressList.length) partner.partner_delivery_address_list = addressList;

    // ── contacts ──
    const cgContactSigs = new Set(cg.contacts.map(contactSignature));
    const cgBillingAddrId = cg.billing ? cg.billing.mk_id : undefined;
    const contactList = [];
    for (const c of t4a.contacts) {
        if (cgContactSigs.has(contactSignature(c))) continue; // already present
        const entry = pruneEmpty({
            mk_address_id: cgBillingAddrId, // attach new contacts to CREAGLOBE's billing address
            name: c.name,
            email: c.email,
            gsm: c.gsm,
            phone: c.phone,
            fax: c.fax
        });
        // A contact with no identifying data isn't worth pushing.
        if (entry.name || entry.email || entry.gsm || entry.phone) {
            contactList.push(entry);
            changed = true;
        }
    }
    if (contactList.length) partner.partner_contact_list = contactList;

    return changed ? partner : null;
}

/**
 * Human-readable summary of what an update_partner payload actually changes on the CREAGLOBE
 * partner — used for the "what updated where" report. Derives the changed top-level fields and
 * how the billing / delivery addresses and contacts were touched from the payload shape.
 */
function summarizeUpdatePayload(payload, cg) {
    const fields = Object.keys(payload).filter(
        (k) => k !== "mk_id" && k !== "partner_delivery_address_list" && k !== "partner_contact_list"
    );

    let billing = null;
    let addressesAdded = 0;
    let addressesUpdated = 0;
    for (const a of payload.partner_delivery_address_list || []) {
        if (a.mk_id) {
            if (cg.billing && a.mk_id === cg.billing.mk_id) billing = "updated";
            else addressesUpdated++;
        } else {
            addressesAdded++;
        }
    }

    return {
        fields,
        billing,
        addressesAdded,
        addressesUpdated,
        contactsAdded: (payload.partner_contact_list || []).length
    };
}

/**
 * Nested items that couldn't ride along with add_partner (which documents only one contact +
 * one delivery address). Appends the remaining contacts and delivery addresses to a freshly
 * created partner via update_partner. `created` is the add_partner response.
 */
function buildAppendNestedPayload(t4a, created) {
    const partner = { mk_id: created.mk_id };
    let has = false;

    // Everything except the first extra address (already sent inline on create).
    const extraAddresses = t4a.addresses.filter((a) => a !== t4a.billing).slice(1);
    if (extraAddresses.length) {
        partner.partner_delivery_address_list = extraAddresses.map((a) =>
            pruneEmpty({
                address_type: a.address_type,
                street: a.street,
                post_number: a.post_number,
                city: a.city,
                province: a.province,
                country: a.country
            })
        );
        has = true;
    }

    // Every contact except the primary (already sent inline on create).
    const billingAddrId = (created.mk_address_id_list && created.mk_address_id_list[0] && created.mk_address_id_list[0].mk_id) || undefined;
    const extraContacts = t4a.contacts.slice(1);
    const contactList = [];
    for (const c of extraContacts) {
        const entry = pruneEmpty({
            mk_address_id: billingAddrId,
            name: c.name,
            email: c.email,
            gsm: c.gsm,
            phone: c.phone,
            fax: c.fax
        });
        if (entry.name || entry.email || entry.gsm || entry.phone) contactList.push(entry);
    }
    if (contactList.length) {
        partner.partner_contact_list = contactList;
        has = true;
    }

    return has ? partner : null;
}

// ── Metakocka calls ──────────────────────────────────────────────────────────

/** Lists ALL partners for a company. get_partner with no search field returns everyone; we
 *  page defensively by offset in case a company ever grows past the 1000 default limit. */
async function listPartners(secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.getPartnerPath}`;
    const PAGE_SIZE = 1000;
    let all = [];
    let offset = 0;
    while (true) {
        const res = await axios.post(
            url,
            { secret_key, company_id, limit: PAGE_SIZE, offset },
            { headers: { "Content-Type": "application/json" } }
        );
        const list = res.data && res.data.partner_list ? res.data.partner_list : [];
        all.push(...list);
        if (list.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
    }
    return all;
}

/** add_partner. Returns { mk_id, mk_address_id_list, ... } on success, or throws on error. */
async function addPartner(payload, secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.addPartnerPath}`;
    const res = await axios.post(
        url,
        { secret_key, company_id, partner: payload },
        { headers: { "Content-Type": "application/json" } }
    );
    // add_partner returns the new ids directly (no opr_code on success); an error carries opr_code.
    if (res.data && res.data.opr_code && res.data.opr_code !== "0") {
        const err = new Error(res.data.opr_desc_app || res.data.opr_desc || "add_partner failed");
        err.mkData = res.data;
        throw err;
    }
    return res.data;
}

/** update_partner. Throws on an opr_code error. */
async function updatePartner(payload, secret_key, company_id) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.updatePartnerPath}`;
    const res = await axios.post(
        url,
        { secret_key, company_id, partner: payload },
        { headers: { "Content-Type": "application/json" } }
    );
    if (res.data && res.data.opr_code && res.data.opr_code !== "0") {
        const err = new Error(res.data.opr_desc_app || res.data.opr_desc || "update_partner failed");
        err.mkData = res.data;
        throw err;
    }
    return res.data;
}

// ── orchestration ────────────────────────────────────────────────────────────

/**
 * Synchronises customers (partners) one way: T4A (master) → CREAGLOBE (mirror).
 *
 * @param {object}  [opts]
 * @param {boolean} [opts.dryRun=false] When true, resolves the full plan (matches / creates /
 *                  updates) WITHOUT writing anything to CREAGLOBE. Used to preview a run.
 * @param {boolean} [opts.includeSuppliers=true] Sync supplier-only partners too (scope = all).
 * @returns {Promise<object>} success flag, counts, per-item errors and UI buckets.
 */
async function customersSync(opts = {}) {
    const { dryRun = false, includeSuppliers = true } = opts;
    const t4aKey = process.env.MK_SECRET_KEY_T4A;
    const t4aCompany = process.env.MK_COMPANY_ID_T4A;
    const cgKey = process.env.MK_SECRET_KEY_CREAGLOBE;
    const cgCompany = process.env.MK_COMPANY_ID_CREAGLOBE;

    const [rawT4A, rawCG] = await Promise.all([
        listPartners(t4aKey, t4aCompany),
        listPartners(cgKey, cgCompany)
    ]);

    let t4aPartners = rawT4A.map(formatPartner);
    if (!includeSuppliers) {
        // Customers only: keep anything flagged as a buyer (or lacking an explicit flag).
        t4aPartners = t4aPartners.filter((p) => p.buyer !== "false");
    }
    const cgPartners = rawCG.map(formatPartner);
    const index = buildMatchIndex(cgPartners);

    const errors = [];
    // Per-customer record of what changed and where (the "what updated where" report).
    const changes = [];
    let matched = 0;
    let created = 0;
    let updated = 0;
    let skipped = 0;

    // Guard against creating the same customer twice in one run (two T4A rows, same tax/name).
    const createdKeys = new Set();

    for (const t4a of t4aPartners) {
        const label = t4a.customer || t4a.count_code || t4a.mk_id;
        const match = findMatch(t4a, index);

        try {
            if (match) {
                matched++;
                const payload = buildUpdatePayload(t4a, match.partner);
                if (!payload) {
                    skipped++;
                    continue;
                }
                if (!dryRun) await updatePartner(payload, cgKey, cgCompany);
                updated++;
                changes.push({
                    action: "update",
                    partner: label,
                    tax_id_number: t4a.tax_id_number || null,
                    via: match.via, // matched by 'tax' or 'name'
                    ...summarizeUpdatePayload(payload, match.partner)
                });
            } else {
                const key = normTax(t4a.tax_id_number) || normStr(t4a.customer);
                if (key && createdKeys.has(key)) {
                    skipped++;
                    continue;
                }
                if (key) createdKeys.add(key);

                if (!dryRun) {
                    const res = await addPartner(buildCreatePayload(t4a), cgKey, cgCompany);
                    const append = buildAppendNestedPayload(t4a, res);
                    if (append) await updatePartner(append, cgKey, cgCompany);
                }
                created++;
                changes.push({
                    action: "create",
                    partner: label,
                    tax_id_number: t4a.tax_id_number || null,
                    via: null,
                    fields: [],
                    billing: t4a.billing ? "added" : null,
                    addressesAdded: t4a.addresses.length,
                    addressesUpdated: 0,
                    contactsAdded: t4a.contacts.length
                });
            }
        } catch (err) {
            errors.push({
                system: "CREAGLOBE",
                partner: label,
                tax_id_number: t4a.tax_id_number || null,
                action: match ? "update" : "add",
                message:
                    (err.mkData && (err.mkData.opr_desc_app || err.mkData.opr_desc)) ||
                    err.message ||
                    "Unknown error"
            });
        }
    }

    return {
        success: errors.length === 0,
        dryRun,
        errors,
        // Per-customer breakdown of exactly what changed and where (create vs update + which
        // fields / addresses / contacts). Empty for unchanged customers.
        changes,
        counts: {
            source: t4aPartners.length,
            target: cgPartners.length,
            matched,
            created,
            updated,
            skipped
        },
        // Buckets drive the admin run-details view.
        buckets: [
            { key: "Created in CREAGLOBE", count: created },
            { key: "Updated in CREAGLOBE", count: updated },
            { key: "Matched (unchanged)", count: skipped }
        ]
    };
}

module.exports = {
    customersSync,
    // exported for unit-testing / dry-run tooling
    formatPartner,
    buildMatchIndex,
    findMatch,
    buildCreatePayload,
    buildUpdatePayload,
    addressSignature,
    contactSignature
};
