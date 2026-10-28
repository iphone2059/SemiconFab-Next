// R8 negative fixture: reference data imported from outside assets/** is not allowed.
import data from '../../../public/reference.json';

export const outsideReference: { allowed: boolean } = data;
