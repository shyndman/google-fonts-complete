const https = require('https');
const postcss = require('postcss');
const userAgents = require('./user-agents.json');

const getPositiveInteger = (value, fallback) => {
    const parsedValue = Number.parseInt(value, 10);

    return parsedValue > 0
        ? parsedValue
        : fallback;
};

const REQUEST_CONCURRENCY = getPositiveInteger(process.env.GOOGLE_FONTS_CONCURRENCY, 24);
const FONT_CONCURRENCY = getPositiveInteger(process.env.GOOGLE_FONTS_FONT_CONCURRENCY, 6);
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: REQUEST_CONCURRENCY });


const mapLimit = async (items, limit, callback) => {
    const results = new Array(items.length);
    let nextIndex = 0;

    const workers = new Array(Math.min(limit, items.length))
        .fill(null)
        .map(async () => {
            while (nextIndex < items.length) {
                const index = nextIndex++;
                results[index] = await callback(items[index], index);
            }
        });

    await Promise.all(workers);

    return results;
};

const createLimit = limit => {
    let activeCount = 0;
    const queue = [];

    const runNext = () => {
        if (activeCount >= limit || queue.length === 0) {
            return;
        }

        activeCount++;
        const { callback, resolve, reject } = queue.shift();

        callback()
            .then(resolve, reject)
            .finally(() => {
                activeCount--;
                runNext();
            });
    };

    return callback => new Promise((resolve, reject) => {
        queue.push({ callback, resolve, reject });
        runNext();
    });
};

const limitRequest = createLimit(REQUEST_CONCURRENCY);


const getSortedObject = object => {
    let sortedObject = {};

    Object.keys(object)
        .sort()
        .forEach(key => {
            const entry = object[key];

            if (Array.isArray(entry) || typeof entry !== 'object') {
                sortedObject[key] = entry;
            } else {
                sortedObject[key] = getSortedObject(entry);
            }
        });

    return sortedObject;
};

const fetch = async(options, delay = 0) => {
    await new Promise(resolve => setTimeout(resolve, delay));
    return limitRequest(() => new Promise((resolve) => {
        https.get({
            ...options,
            agent: httpsAgent
        }, response => {
            let result = '';

            response.on('data', data => {
                result += data;
            });

            response.on('end', () => {
                resolve(result);
            });
        });
    }));
};

const mergeConvertedFont = (convertedFont, partialFont) => {
    const variants = convertedFont.variants;

    Object.keys(partialFont.variants).forEach(fontStyle => {
        variants[fontStyle] = variants[fontStyle] || {};

        Object.keys(partialFont.variants[fontStyle]).forEach(fontWeight => {
            const existingVariant = variants[fontStyle][fontWeight] || {
                local: [],
                url: {}
            };
            const partialVariant = partialFont.variants[fontStyle][fontWeight];

            partialVariant.local.forEach(localFont => {
                if (existingVariant.local.indexOf(localFont) === -1) {
                    existingVariant.local.push(localFont);
                }
            });

            existingVariant.url = {
                ...existingVariant.url,
                ...partialVariant.url
            };
            variants[fontStyle][fontWeight] = existingVariant;
        });
    });

    return {
        ...convertedFont,
        variants,
        unicodeRange: {
            ...convertedFont.unicodeRange,
            ...partialFont.unicodeRange
        }
    };
};


const convertFont = async ({ convertedFont, family, format }, fetchOptions) => {
    let { variants, unicodeRange } = convertedFont;

    const css = await fetch(fetchOptions);

    if (css) {
        let subset = null;
        const root = postcss.parse(css);
        root.each(rule => {
            if (rule.type === 'comment') {
                subset = rule.text;
            }

            if (rule.type === 'atrule' && rule.name === 'font-face') {
                let fontStyle = 'normal';
                let fontWeight = '400';

                rule.walkDecls('font-weight', decl => {
                    fontWeight = decl.value;
                });

                rule.walkDecls('font-style', decl => {
                    fontStyle = decl.value;
                });
                variants[fontStyle] = variants[fontStyle] || {};
                variants[fontStyle][fontWeight] = variants[fontStyle][fontWeight] || {
                    local: [],
                    url: {}
                };

                rule.walkDecls('src', decl => {
                    postcss.list.comma(decl.value).forEach(value => {
                        value.replace(
                            /(local|url)\((.+?)\)/g,
                            (match, type, path) => {
                                if (type === 'local') {
                                    if (
                                        variants[fontStyle][fontWeight].local.indexOf(path) === -1
                                    ) {
                                        variants[fontStyle][fontWeight].local.push(path);
                                    }
                                } else if (type === 'url') {
                                    variants[fontStyle][fontWeight].url[format] = path;
                                }
                            }
                        );
                    });
                });

                rule.walkDecls('unicode-range', decl => {
                    unicodeRange = {
                        ...unicodeRange,
                        [subset]: decl.value
                    }
                });

                console.log('Captured', family, fontStyle, fontWeight, 'as', format, '...');
            }
        });
        return {
            ...convertedFont,
            variants,
            unicodeRange
        };
    } else {
        console.log('Rejected', family, 'as', format, '...');
        return null;
    }
};

const getFetchOptions = ({ family, variants, format, pathCb }) => {
    const userAgent = userAgents[format];

    const variantsList = ['eot', 'svg'].includes(format)
        ? variants
        : [variants.join(',')];

    return variantsList.map(variant => ({
        host: 'fonts.googleapis.com',
        path: encodeURI(pathCb({ family, variant })),
        headers: {
            'User-Agent': userAgent
        }
    }));
}


const convertFontsOptions = async (fonts, pathCb) => {
    const convertedFonts = await mapLimit(fonts, FONT_CONCURRENCY, async font => {
        const { family, variants, ...originalFont } = font;

        const agents = Object.keys(userAgents);

        let convertedFont = {
            ...originalFont,
            variants: {},
            unicodeRange: {}
        };

        const conversions = agents.reduce((acc, format) => [
            ...acc,
            ...getFetchOptions({ family, variants, format, pathCb })
                .map(options => ({ format, options }))
        ], []);

        const partialFonts = await mapLimit(conversions, REQUEST_CONCURRENCY, ({ format, options }) => {
            return convertFont({
                convertedFont: {
                    ...originalFont,
                    variants: {},
                    unicodeRange: {}
                },
                family,
                format
            }, options);
        });

        partialFonts.forEach(partialFont => {
            if (partialFont) {
                convertedFont = mergeConvertedFont(convertedFont, partialFont);
            }
        });

        return [family, convertedFont];
    });

    const results = {};

    convertedFonts.forEach(([family, convertedFont]) => {
        results[family] = convertedFont;
    });

    return results;
};

const getChunkedFonts = fonts => fonts.reduce((acc, font) => {
    const key = font?.family[0];
    acc[key] = acc[key]
        ? [
            ...acc[key],
            font
        ]
        : [font]
    return acc;
}, {})

module.exports = {
    fetch,
    convertFont,
    mapLimit,
    mergeConvertedFont,
    getSortedObject,
    getFetchOptions,
    getChunkedFonts,
    convertFontsOptions
}
