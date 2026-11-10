// Family cars: the number plates that homeassistant/car_arrivals.yaml announces as "<owner> is home".
// They're kept in Home Assistant (input_text.family_cars) so every screen and the automation share them.
// The text is "PLATE=owner;PLATE=owner", where owner is a person entity (person.andy) or a plain name.

export const CARS_ENTITY = 'input_text.family_cars';
export const CARS_MAX = 255; // input_text's limit

/** "abc 123" → "ABC123": what's stored and compared. */
export const cleanPlate = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const cleanOwner = (o) => String(o || '').replace(/[=;]/g, ' ').trim();

/** The cars in the helper's text, as [{ plate, owner }]. */
export function parseCars(text) {
  return String(text || '').split(';').map((part) => {
    const i = part.indexOf('=');
    return i < 0 ? null : { plate: cleanPlate(part.slice(0, i)), owner: cleanOwner(part.slice(i + 1)) };
  }).filter((c) => c && c.plate && c.owner);
}

export const serializeCars = (cars) => cars.map((c) => `${cleanPlate(c.plate)}=${cleanOwner(c.owner)}`).join(';');

/** The list with `car` added, replacing any car with the same plate; or an error message. */
export function addCar(cars, car) {
  const plate = cleanPlate(car.plate);
  const owner = cleanOwner(car.owner);
  if (plate.length < 2) return { error: 'Type the number plate first' };
  if (!owner) return { error: 'Pick whose car it is' };
  const list = [...cars.filter((c) => c.plate !== plate), { plate, owner }];
  if (serializeCars(list).length > CARS_MAX) return { error: 'That’s as many cars as Home Assistant can hold' };
  return { cars: list };
}
