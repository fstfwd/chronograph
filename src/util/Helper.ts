export const uppercaseFirst = (str : string) : string => str.slice(0, 1).toUpperCase() + str.slice(1)


export const isAtomicValue = (value : any) : boolean => Object(value) !== value


export function lazyProperty <T extends object, Property extends keyof T> (target : T, storage : string | symbol, builder : () => T[ Property ]) : T[ Property ] {
    if (target[ storage ] !== undefined) return target[ storage ]

    return target[ storage ] = builder()
}

