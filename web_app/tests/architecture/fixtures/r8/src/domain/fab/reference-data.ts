// R8 positive fixture: a static reference-data import from web_app/assets is allowed.
import reference from '../../../assets/reference.json';

export const referenceData: { allowed: boolean } = reference;
