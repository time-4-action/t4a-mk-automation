const axios = require("axios");
const path = require("path")
const fs = require("fs");
const config = require("../../config/config.json");

const COMPANY_ID_TO_NAME = {
    [process.env.MK_COMPANY_ID_T4A]: 'T4A',
    [process.env.MK_COMPANY_ID_CREAGLOBE]: 'CREAGLOBE'
};

/**
 * Parses a value to a number, handling comma as a decimal separator if the value is a string.
 * @param {string|number} value - The value to parse.
 * @returns {number} The parsed number.
 */
function parseNumber(value) {
    if (typeof value === 'string') {
        return Number(value.replace(',', '.'));
    }
    return value; // already number
}

/**
 * Flattens a nested category tree structure into a flat array of category paths.
 * @param {Array<Object>} categoryTree - The array of category tree nodes.
 * @returns {Array<Object>|undefined} An array of objects, where each object has a 'category' key containing an array representing the category path, or undefined if the input is not an array.
 */
function flattenCategories(categoryTree) {
    if (!Array.isArray(categoryTree)) return undefined; // guard

    const result = [];

    function traverse(node, path = []) {
        if (!node || !node.tree_node_label) return;

        const newPath = [...path, node.tree_node_label];

        if (!node.tree_node_list || !Array.isArray(node.tree_node_list) || node.tree_node_list.length === 0) { // If no children, it's a leaf node
            result.push({ category: newPath }); // <-- always array now
        } else {
            node.tree_node_list.forEach(child => traverse(child, newPath));
        }
    }

    categoryTree.forEach(node => traverse(node));
    return result;
}

/**
 * Formats a list of raw product objects into a standardized format.
 * @param {Array<Object>} list - The raw list of product objects.
 * @returns {Array<Object>} The formatted list of product objects.
 */
function formatProductList(list) {
    return list.map((p) =>
        Object.fromEntries(
            Object.entries({
                count_code: p.count_code,
                code: p.code,
                barcode: p.barcode,
                name: p.name,
                unit: p.unit,
                service: p.service,
                sales: p.sales,
                activated: p.activated,
                purchasing: p.purchasing,
                eshop_sync: p.eshop_sync,
                height: parseNumber(p.height),
                width: parseNumber(p.width),
                depth: parseNumber(p.depth),
                weight: parseNumber(p.weight),
                // localization: p.localization,
                asset: p.asset,
                // lot_numbers: p.lot_numbers,
                norm: p.norm,
                // serial_numbers: p.serial_numbers,
                work: p.work,
                categories: flattenCategories(p.category_tree_list),
                name_desc: p.name_desc,
                customs_fee: p.customs_fee,
                country: p.country,
                koli_package_amount: p.koli_package_amount,
                gross_weight: parseNumber(p.gross_weight)
            }).filter(([_, v]) => v !== undefined)
        )
    );
}

/**
 * Performs a deep comparison of two values, ignoring case for strings and order for array elements.
 * @param {*} a - The first value to compare.
 * @param {*} b - The second value to compare.
 * @returns {boolean} True if the values are deeply equal (case-insensitive for strings, order-agnostic for arrays), false otherwise.
 */
function deepEqualIgnoreCaseUnordered(a, b) {
  if (typeof a === 'string' && typeof b === 'string') {
    return a.toLowerCase() === b.toLowerCase();
  }

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    
    // For each element in a, there must be a match in b
    return a.every(elA => b.some(elB => deepEqualIgnoreCaseUnordered(elA, elB)));
  }

  if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) return false;
    return aKeys.every(k => deepEqualIgnoreCaseUnordered(a[k], b[k]));
  }

  return a === b;
}

/**
 * Generates a smart merge delta between two product systems (systemA and systemB).
 * SystemA is considered the main system, and its values win in conflicts.
 * @param {Array<Object>} systemA - The product list from system A.
 * @param {Array<Object>} systemB - The product list from system B.
 * @param {string} nameA - The identifier for system A.
 * @param {string} nameB - The identifier for system B.
 * @param {string} [outputDir='./delta'] - The directory to save the delta files.
 * @returns {{changesA: Array<Object>, changesB: Array<Object>, newInA: Array<Object>, newInB: Array<Object>}} An object containing arrays of changes for each system and new products.
 */
function generateSmartMerge(systemA, systemB, nameA, nameB, outputDir = './delta') {
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const mapA = Object.fromEntries(systemA.map(p => [p.code, p]));
    const mapB = Object.fromEntries(systemB.map(p => [p.code, p]));

    const changesB = []; // B needs to update to match A
    const changesA = []; // A can take non-conflicting fields from B
    let newInA = [];
    let newInB = [];

    for (const aProduct of systemA) {
        const bProduct = mapB[aProduct.code];

        if (!bProduct) {
            // Product exists only in System A, so it's new for System B
            newInB.push({ ...aProduct });
            continue;
        }

        const bUpdate = {};
        const aUpdate = {};

        for (const key of new Set([...Object.keys(aProduct), ...Object.keys(bProduct)])) { // Iterate over all unique keys from both products
            if (key === 'count_code' || key === "sales" || key ==="service" || key === "purchasing" || key === "code") continue;
            
            const aValue = aProduct[key];
            const bValue = bProduct[key];

            const areObjects = typeof aValue === 'object' && aValue !== null &&
                typeof bValue === 'object' && bValue !== null;
            
            const equal = deepEqualIgnoreCaseUnordered(aValue, bValue);

            if (key === "categories" && !equal) {
                // console.log(aValue, bValue, equal)
            }

            if (!equal) {
                if (aValue !== undefined && bValue !== undefined) {
                    bUpdate[key] = aValue; // Conflict: System A's value wins, so B needs to update
                } else if (aValue === undefined && bValue !== undefined) {
                    aUpdate[key] = bValue; // Value exists only in B, so A can adopt it
                } else if (aValue !== undefined && bValue === undefined) {
                    bUpdate[key] = aValue; // Value exists only in A, so B needs to adopt it
                }
            }
        }

        // Push updates keeping original system count_code & service
        if (bUpdate && Object.keys(bUpdate).length > 0) {
            changesB.push({
                ...bUpdate,
                count_code: bProduct.count_code,
                sales: aProduct.sales,
                service: bProduct.service,
                purchasing: bProduct.purchasing,
                code: bProduct.code
            });
        }

        if (aUpdate && Object.keys(aUpdate).length > 0) {
            changesA.push({
                ...aUpdate,
                count_code: aProduct.count_code,
                sales: aProduct.sales,
                service: aProduct.service,
                purchasing: bProduct.purchasing, 
                code: aProduct.code
            });
        }
    }

    // Products only in B → add to A
    for (const bProduct of systemB) {
        if (!mapA[bProduct.code]) {
            const { count_code, ...rest } = bProduct;
            newInA.push({ ...rest });
        }
    }

    // Products only in A → add to B
    for (const aProduct of systemA) {
        if (!mapB[aProduct.code]) {
            const { count_code, ...rest } = aProduct;
            newInB.push({ ...rest });
        }
    }

    // fs.writeFileSync(`${outputDir}/changes${nameA}.json`, JSON.stringify(changesA, null, 2));
    // fs.writeFileSync(`${outputDir}/changes${nameB}.json`, JSON.stringify(changesB, null, 2));
    // fs.writeFileSync(`${outputDir}/newIn${nameA}.json`, JSON.stringify(newInA, null, 2));
    // fs.writeFileSync(`${outputDir}/newIn${nameB}.json`, JSON.stringify(newInB, null, 2));

    // console.log('✅ Smart merged delta files created in', outputDir);

    return { changesA, changesB, newInA, newInB };
}

/**
 * Updates products in Metakocka.
 * @param {Array<Object>} updates - An array of product objects to update.
 * @param {string} secret_key - The Metakocka secret key.
 * @param {string} company_id - The Metakocka company ID.
 * @returns {Array<Object>} An array of error codes or objects if any updates failed.
 * @param {string} systemIdentifier - A string to identify the system (e.g., 'System A').
 */
async function updateProducts(updates, secret_key, company_id, systemIdentifier) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productUpdatePath}`;
    const error_codes = [];

    for (const update of updates) {
        try {
            const res = await axios.post(
                url,
                {
                    secret_key,
                    company_id,
                    ...update
                },
                {
                    headers: { "Content-Type": "application/json" }
                }
            );
            // console.log(res.dat
            // a)

            if (res.data.opr_code !== "0") {
                error_codes.push({
                    system: systemIdentifier,
                    product_code: update.code,
                    action: 'update',
                    opr_desc_app: res.data.opr_desc_app,
                    opr_desc: res.data.opr_desc
                });
            }
        } catch (err) {
            error_codes.push({
                system: systemIdentifier,
                update,
                error: err.response?.data || err.message
            });
        }
    }

    return error_codes;
}

/**
 * Adds new products to Metakocka.
 * @param {Array<Object>} products - An array of product objects to add.
 * @param {string} secret_key - The Metakocka secret key.
 * @param {string} company_id - The Metakocka company ID.
 * @returns {Array<Object>} An array of error codes or objects if any products failed to add.
 * @param {string} systemIdentifier - A string to identify the system (e.g., 'System A').
 */
async function addProducts(products, secret_key, company_id, systemIdentifier) {
    const url = `${config.metakocka.baseUrl}${config.metakocka.productAddPath}`;
    const error_codes = [];

    for (const product of products) {
        try {
            const res = await axios.post(
                url,
                {
                    secret_key,
                    company_id,
                    ...product
                },
                {
                    headers: { "Content-Type": "application/json" }
                }
            );

            if (res.data.opr_code !== "0") {
                error_codes.push({
                    system: systemIdentifier,
                    product_code: product.code,
                    action: 'add',
                    opr_desc_app: res.data.opr_desc_app,
                    opr_desc: res.data.opr_desc
                });
            }
        } catch (err) {
            error_codes.push({
                system: systemIdentifier,
                product,
                error: err.response?.data || err.message
            });
        }
    }

    return error_codes;
}

/**
 * Lists all products from Metakocka, handling pagination.
 * @param {string} secret_key - The Metakocka secret key.
 * @param {string} company_id - The Metakocka company ID.
 * @returns {Array<Object>} An array of product objects.
 */
async function listProducts(secret_key, company_id) {
    var productList = [];
    var offset = 0;
    var loop = true;
    const baseRequestData = {
        secret_key: secret_key,
        company_id: company_id,
        return_category: true,
        limit: 1000
    }

    while (loop) {
        const productListResponse = await axios.post(
            `${config.metakocka.baseUrl}${config.metakocka.productListPath}`,
            {
                ...baseRequestData,
                offset: offset
            },
            {
                headers: {
                    "Content-Type": "application/json"
                }
            }
        );
        // console.log({...baseRequestData})
        console.log(productListResponse.data)
        productList.push(...productListResponse.data.product_list)
        
        offset += 1000;

        if (productListResponse.data.product_list_count < 1000) {
            loop = false;
        }
    }
    return productList

}

/**
 * Synchronizes products between two Metakocka systems.
 * @param {string} systemAKey - Secret key for system A (main system).
 * @param {string} systemACompany - Company ID for system A.
 * @param {string} systemBKey - Secret key for system B.
 * @param {string} systemBCompany - Company ID for system B.
 */
async function productsSync(systemAKey, systemACompany, systemBKey, systemBCompany) {
    try {
        // console.log("Starting product synchronization...");

        const [productsA, productsB] = await Promise.all([
            listProducts(systemAKey, systemACompany),
            listProducts(systemBKey, systemBCompany)
        ]);
        // console.log(`Found ${productsA.length} products in System A and ${productsB.length} in System B.`);

        const productsAFormated = formatProductList(productsA);
        const productsBFormated = formatProductList(productsB);

        const nameA = COMPANY_ID_TO_NAME[systemACompany] || 'SystemA';
        const nameB = COMPANY_ID_TO_NAME[systemBCompany] || 'SystemB';

        const { changesA, changesB, newInA, newInB } = generateSmartMerge(productsAFormated, productsBFormated, nameA, nameB);

        const [updateAErrorCodes, updateBErrorCodes, addProductsAErrorCodes, addProductsBErrorCodes] = await Promise.all([
            updateProducts(changesA, systemAKey, systemACompany, nameA),
            updateProducts(changesB, systemBKey, systemBCompany, nameB),
            addProducts(newInA, systemAKey, systemACompany, nameA),
            addProducts(newInB, systemBKey, systemBCompany, nameB)
        ]);

        const allErrors = [...updateAErrorCodes, ...updateBErrorCodes, ...addProductsAErrorCodes, ...addProductsBErrorCodes];

        if (allErrors.length > 0) {
            console.error("Synchronization completed with errors:", allErrors);
        } else {
            // console.log("Synchronization completed successfully.");
        }

        // Here you could use the sendSyncReport function with the results
        // await sendSyncReport({ errors: allErrors, changesA, changesB, newInA, newInB });

        return {
            success: allErrors.length === 0,
            errors: allErrors,
            [`changes${nameA}`]: changesA,
            [`changes${nameB}`]: changesB,
            [`newIn${nameA}`]: newInA,
            [`newIn${nameB}`]: newInB
        };
    } catch (error) {
        console.error("A critical error occurred during synchronization:", error);
        // await sendSyncReport({ criticalError: error.message || error });
        throw error; // Re-throw the error to be handled by the caller
    }
}

const PRODUCTS_SYNC_PARAMS = [process.env.MK_SECRET_KEY_T4A, process.env.MK_COMPANY_ID_T4A, process.env.MK_SECRET_KEY_CREAGLOBE, process.env.MK_COMPANY_ID_CREAGLOBE]

module.exports = {
    productsSync,
    PRODUCTS_SYNC_PARAMS
};